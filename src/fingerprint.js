import { Router } from 'express';
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { z, id, username, parse } from './validation.js';
import { ApiError, fail, rateLimit, transaction } from './security.js';

const deviceIdSchema = z.object({ deviceId: id }).strict();
const challengeSchema = z.object({ username, deviceId: id }).strict();
const verifySchema = challengeSchema.extend({ challengeId: id,
  signature: z.string().min(8).max(2048).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
const enrollSchema = deviceIdSchema.extend({ publicKey: z.string().min(80).max(8192),
  deviceName: z.string().trim().min(1).max(80) }).strict();
const rejected = () => new ApiError(401, 'FINGERPRINT_INVALID', 'Không xác thực được vân tay. Hãy đăng nhập bằng mật khẩu và OTP để kiểm tra liên kết thiết bị.');
const active = user => user && user.status === 'active' && user.email_verified === true && !user.deleted_at;

export function fingerprintPublicKey(value) {
  try {
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\s*$/.test(value)) throw new Error('public key required');
    const key = createPublicKey(value);
    const details = key.asymmetricKeyDetails;
    const algorithm = key.asymmetricKeyType === 'rsa' && details.modulusLength >= 2048 && details.modulusLength <= 4096
      ? 'rsa-sha256' : key.asymmetricKeyType === 'ec' && details.namedCurve === 'prime256v1' ? 'p256-sha256' : null;
    if (!algorithm) throw new Error('unsupported algorithm');
    return { algorithm, pem: key.export({ type: 'spki', format: 'pem' }), key };
  } catch { fail(422, 'FINGERPRINT_KEY_INVALID', 'Khóa thiết bị cần là RSA 2048–4096 bit hoặc P-256 hợp lệ.'); }
}

export function createFingerprint({ pool, config, now = () => new Date(), issueSession }) {
  const publicRouter = Router(), privateRouter = Router();
  publicRouter.use('/fingerprint', rateLimit({ now, max: 30, windowMs: 5 * 60000 }),
    rateLimit({ now, max: 20, windowMs: 5 * 60000, key: req => String(req.body?.username ?? '').trim().toLowerCase().slice(0, 32) }));
  privateRouter.use('/fingerprint', rateLimit({ now, max: 30, windowMs: 5 * 60000, key: req => req.user.id }));
  const view = row => ({ id: row.id, deviceId: row.device_id, deviceName: row.device_name, createdAt: row.created_at });

  privateRouter.get('/fingerprint/status', async (req, res) => {
    const input = parse(deviceIdSchema, req.query);
    const row = (await pool.query('SELECT * FROM fingerprint_devices WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL', [req.user.id, input.deviceId])).rows[0];
    const session = (await pool.query('SELECT * FROM sessions WHERE id=$1 AND user_id=$2', [req.sessionId, req.user.id])).rows[0];
    const age = session ? now().getTime() - new Date(session.created_at).getTime() : Infinity;
    const canEnroll = Boolean(session && !session.revoked_at && session.auth_method === 'password_otp' && Number.isFinite(age) && age >= 0 && age <= 15 * 60000);
    res.json({ data: { registered: Boolean(row), device: row ? view(row) : null, canEnroll, username: req.user.username } });
  });
  privateRouter.post('/fingerprint/enroll', async (req, res) => {
    const input = parse(enrollSchema, req.body), publicKey = fingerprintPublicKey(input.publicKey), time = now();
    const device = await transaction(pool, async db => {
      const user = (await db.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.user.id])).rows[0];
      const session = (await db.query('SELECT * FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.sessionId, req.user.id])).rows[0];
      const age = session ? time.getTime() - new Date(session.created_at).getTime() : Infinity;
      if (!active(user) || !session || session.revoked_at || session.auth_method !== 'password_otp' || !Number.isFinite(age) || age < 0 || age > 15 * 60000) {
        fail(403, 'FINGERPRINT_REAUTH_REQUIRED', 'Hãy đăng nhập lại bằng mật khẩu và OTP trong 15 phút trước khi đăng ký vân tay.');
      }
      const current = (await db.query('SELECT * FROM fingerprint_devices WHERE user_id=$1 AND device_id=$2 FOR UPDATE', [user.id, input.deviceId])).rows[0];
      const registered = (await db.query('SELECT id FROM fingerprint_devices WHERE user_id=$1 AND revoked_at IS NULL', [user.id])).rows;
      if ((!current || current.revoked_at) && registered.length >= 10) fail(409, 'FINGERPRINT_DEVICE_LIMIT', 'Tài khoản đã liên kết tối đa 10 thiết bị. Hãy hủy thiết bị cũ trước.');
      await db.query('UPDATE fingerprint_challenges SET consumed_at=$1 WHERE user_id=$2 AND device_id=$3 AND consumed_at IS NULL', [time, user.id, input.deviceId]);
      if (current) return (await db.query('UPDATE fingerprint_devices SET public_key=$1,key_algorithm=$2,device_name=$3,created_at=$4,revoked_at=NULL WHERE id=$5 RETURNING *',
        [publicKey.pem, publicKey.algorithm, input.deviceName, time, current.id])).rows[0];
      return (await db.query('INSERT INTO fingerprint_devices(id,user_id,device_id,public_key,key_algorithm,device_name,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [randomUUID(), user.id, input.deviceId, publicKey.pem, publicKey.algorithm, input.deviceName, time])).rows[0];
    });
    res.status(201).json({ data: view(device) });
  });
  privateRouter.delete('/fingerprint/devices/:id', async (req, res) => {
    const bindingId = parse(id, req.params.id);
    await transaction(pool, async db => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
      const binding = (await db.query('SELECT * FROM fingerprint_devices WHERE id=$1 AND user_id=$2 FOR UPDATE', [bindingId, req.user.id])).rows[0];
      if (!binding) fail(404, 'NOT_FOUND', 'Không tìm thấy thiết bị vân tay của tài khoản.');
      await db.query('UPDATE fingerprint_devices SET revoked_at=$1 WHERE id=$2', [now(), binding.id]);
      await db.query('UPDATE fingerprint_challenges SET consumed_at=$1 WHERE user_id=$2 AND device_id=$3 AND consumed_at IS NULL', [now(), req.user.id, binding.device_id]);
    });
    res.json({ data: { revoked: true } });
  });
  publicRouter.post('/fingerprint/challenge', async (req, res) => {
    const input = parse(challengeSchema, req.body), time = now();
    const challenge = await transaction(pool, async db => {
      const user = (await db.query('SELECT * FROM users WHERE username=$1 FOR UPDATE', [input.username])).rows[0];
      if (!active(user)) throw rejected();
      const device = (await db.query('SELECT * FROM fingerprint_devices WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL FOR UPDATE', [user.id, input.deviceId])).rows[0];
      if (!device) throw rejected();
      // User lock serializes issue/enroll/revoke/approval. Keep only one nonce
      // for this binding; old proof is invalid even when the key stays the same.
      await db.query('DELETE FROM fingerprint_challenges WHERE user_id=$1 AND device_id=$2', [user.id, input.deviceId]);
      const challengeId = randomUUID(), expiresAt = new Date(time.getTime() + 2 * 60000);
      const payload = ['HN-FINGERPRINT-V1', config.issuer ?? 'attendance-api', challengeId, user.id, input.deviceId,
        randomBytes(32).toString('base64url'), expiresAt.toISOString()].join('\n');
      await db.query('INSERT INTO fingerprint_challenges(id,user_id,device_id,payload,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [challengeId, user.id, input.deviceId, payload, expiresAt, time]);
      return { challengeId, payload, expiresAt };
    });
    res.json({ data: challenge });
  });
  publicRouter.post('/fingerprint/verify', async (req, res) => {
    const input = parse(verifySchema, req.body);
    const result = await transaction(pool, async db => {
      const lookup = (await db.query('SELECT user_id FROM fingerprint_challenges WHERE id=$1', [input.challengeId])).rows[0];
      if (!lookup) return { error: rejected() };
      const user = (await db.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [lookup.user_id])).rows[0];
      const challenge = (await db.query('SELECT * FROM fingerprint_challenges WHERE id=$1 FOR UPDATE', [input.challengeId])).rows[0];
      if (!challenge || challenge.consumed_at || challenge.attempts >= 5 || new Date(challenge.expires_at) <= now()) return { error: rejected() };
      if (!active(user) || user.username !== input.username || challenge.device_id !== input.deviceId) return { error: rejected() };
      const device = (await db.query('SELECT * FROM fingerprint_devices WHERE user_id=$1 AND device_id=$2 FOR UPDATE', [user.id, input.deviceId])).rows[0];
      if (!device || device.revoked_at) return { error: rejected() };
      let valid = false;
      try {
        const bytes = Buffer.from(input.signature, 'base64');
        valid = bytes.toString('base64') === input.signature && verify('sha256', Buffer.from(challenge.payload, 'utf8'), createPublicKey(device.public_key), bytes);
      } catch { valid = false; }
      if (!valid) {
        await db.query('UPDATE fingerprint_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]);
        return { error: rejected() };
      }
      await db.query('UPDATE fingerprint_challenges SET consumed_at=$1 WHERE id=$2', [now(), challenge.id]);
      await db.query('UPDATE fingerprint_devices SET last_used_at=$1 WHERE id=$2', [now(), device.id]);
      return { session: await issueSession(db, user, 'fingerprint') };
    });
    if (result.error) throw result.error;
    res.json({ data: result.session });
  });
  return { publicRouter, privateRouter };
}
