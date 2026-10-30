import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z, name, username, email, password, id, parse } from './validation.js';
import { ApiError, fail, hashPassword, checkPassword, otpCode, otpHash, opaqueToken, tokenHash, constantEqual, publicUser, transaction, rateLimit } from './security.js';

export function createAuth({ pool, config, mailer, now }) {
  const router = Router();
  const secret = new TextEncoder().encode(config.jwtSecret);
  const issuer = config.issuer ?? 'attendance-api', audience = config.audience ?? 'attendance-app';
  const otpFailure = () => new ApiError(401, 'OTP_INVALID', 'Mã OTP không hợp lệ hoặc đã hết hạn.');
  const loginFailure = () => new ApiError(401, 'CREDENTIALS_INVALID', 'Thông tin đăng nhập không hợp lệ.');
  const mask = (address) => { const [local, domain] = address.split('@'); return `${local.slice(0, Math.min(2, local.length))}***@${domain}`; };
  const challengeView = (row, user) => ({ challengeId: row.id, maskedEmail: mask(user.email), expiresAt: row.expires_at,
    retryAfterSeconds: Math.max(0, Math.ceil((new Date(row.last_sent_at).getTime() + 60000 - now().getTime()) / 1000)), purpose: row.purpose });
  async function sendCode(row, user, code) {
    try { await mailer.sendOtp({ email: user.email, fullName: user.full_name, code, purpose: row.purpose }); }
    catch { await pool.query('UPDATE otp_challenges SET consumed_at=$1 WHERE id=$2', [now(), row.id]); fail(503, 'EMAIL_UNAVAILABLE', 'Chưa gửi được email xác thực. Vui lòng thử lại sau.'); }
  }
  async function issueChallenge(user, purpose) {
    const challengeId = randomUUID(), code = otpCode(), time = now();
    const row = await transaction(pool, async (db) => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const recent = await db.query('SELECT last_sent_at FROM otp_challenges WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [user.id]);
      if (recent.rows[0] && new Date(recent.rows[0].last_sent_at).getTime() + 60000 > time.getTime()) fail(429, 'OTP_COOLDOWN', 'Vui lòng chờ 60 giây trước khi yêu cầu OTP mới.');
      await db.query('UPDATE otp_challenges SET consumed_at=$1 WHERE user_id=$2 AND consumed_at IS NULL', [time, user.id]);
      const result = await db.query('INSERT INTO otp_challenges(id,user_id,purpose,code_hash,expires_at,last_sent_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *',
        [challengeId, user.id, purpose, otpHash(config.otpSecret, challengeId, code), new Date(time.getTime() + 10 * 60000), time]);
      return result.rows[0];
    });
    await sendCode(row, user, code);
    return challengeView(row, user);
  }
  async function sessionTokens(db, user, sessionId = randomUUID(), method = 'password_otp') {
    const time = now();
    if (!arguments[2]) await db.query('INSERT INTO sessions(id,user_id,created_at,auth_method) VALUES($1,$2,$3,$4)', [sessionId, user.id, time, method]);
    const refreshToken = opaqueToken();
    await db.query('INSERT INTO refresh_tokens(id,session_id,token_hash,expires_at) VALUES($1,$2,$3,$4)', [randomUUID(), sessionId, tokenHash(refreshToken), new Date(time.getTime() + 30 * 86400000)]);
    const issuedAt = Math.floor(time.getTime() / 1000);
    const accessToken = await new SignJWT({ sid: sessionId }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user.id)
      .setIssuer(issuer).setAudience(audience).setIssuedAt(issuedAt).setExpirationTime(issuedAt + 15 * 60).sign(secret);
    return { accessToken, refreshToken, user: publicUser(user) };
  }
  const requireAuth = async (req, _res, next) => {
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
    if (!token) return next(new ApiError(401, 'AUTH_REQUIRED', 'Vui lòng đăng nhập.'));
    let payload;
    try { ({ payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], issuer, audience, currentDate: now(), typ: 'JWT' })); }
    catch { return next(new ApiError(401, 'TOKEN_INVALID', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.')); }
    if (!id.safeParse(payload.sub).success || !id.safeParse(payload.sid).success) return next(new ApiError(401, 'TOKEN_INVALID', 'Phiên đăng nhập không hợp lệ.'));
    const { rows } = await pool.query('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id=$2 AND s.revoked_at IS NULL AND u.deleted_at IS NULL', [payload.sub, payload.sid]);
    if (!rows[0]) return next(new ApiError(401, 'SESSION_REVOKED', 'Phiên đăng nhập đã kết thúc.'));
    if (rows[0].status === 'suspended') return next(new ApiError(403, 'ACCOUNT_SUSPENDED', 'Tài khoản đã bị tạm ngưng.'));
    req.user = rows[0]; req.sessionId = payload.sid; next();
  };
  const requireActive = (req, _res, next) => req.user.status === 'active' && req.user.email_verified
    ? next() : next(new ApiError(403, 'ACCOUNT_PENDING', 'Tài khoản đang chờ quản trị viên phê duyệt.'));
  const authLimiter = rateLimit({ now, max: 80 });
  router.use(authLimiter);
  router.post('/register', async (req, res) => {
    const input = parse(z.object({ fullName: name, username, email, password }).strict(), req.body);
    const exists = await pool.query('SELECT id FROM users WHERE username=$1 OR email=$2', [input.username, input.email]);
    if (exists.rows.length) fail(409, 'ACCOUNT_EXISTS', 'Tên đăng nhập hoặc email đã được sử dụng.');
    const result = await pool.query("INSERT INTO users(id,full_name,username,email,password_hash,role,status,created_at) VALUES($1,$2,$3,$4,$5,'employee','pending',$6) RETURNING *",
      [randomUUID(), input.fullName, input.username, input.email, await hashPassword(input.password), now()]);
    res.status(202).json({ data: await issueChallenge(result.rows[0], 'register') });
  });
  router.post('/login', async (req, res) => {
    const input = parse(z.object({ username, password: z.string().min(1).max(128) }).strict(), req.body);
    const { rows } = await pool.query('SELECT * FROM users WHERE username=$1 AND deleted_at IS NULL', [input.username]);
    const user = rows[0];
    // The same password derivation runs for unknown usernames to reduce enumeration by timing.
    const stored = user?.password_hash ?? 'scrypt$16384$8$1$00000000000000000000000000000000$' + '0'.repeat(128);
    const valid = await checkPassword(input.password, stored);
    if (!user || !valid || user.status === 'suspended') throw loginFailure();
    res.json({ data: await issueChallenge(user, user.email_verified ? 'login' : 'register') });
  });
  router.post('/verify-otp', async (req, res) => {
    const input = parse(z.object({ challengeId: id, code: z.string().regex(/^\d{6}$/) }).strict(), req.body);
    const outcome = await transaction(pool, async (db) => {
      const lookup = (await db.query('SELECT user_id FROM otp_challenges WHERE id=$1', [input.challengeId])).rows[0];
      if (!lookup) return { error: otpFailure() };
      // Match issueChallenge/admin-update lock ordering: user first, then challenge.
      const found = await db.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [lookup.user_id]);
      let user = found.rows[0];
      if (!user || user.status === 'suspended') return { error: otpFailure() };
      const { rows } = await db.query('SELECT * FROM otp_challenges WHERE id=$1 FOR UPDATE', [input.challengeId]);
      const row = rows[0];
      if (!row || row.consumed_at || row.attempts >= 5 || new Date(row.expires_at) <= now()) return { error: otpFailure() };
      if (!constantEqual(row.code_hash, otpHash(config.otpSecret, row.id, input.code))) {
        await db.query('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1', [row.id]);
        return { error: otpFailure() };
      }
      await db.query('UPDATE otp_challenges SET consumed_at=$1 WHERE id=$2', [now(), row.id]);
      if (!user.email_verified) user = (await db.query('UPDATE users SET email_verified=true WHERE id=$1 RETURNING *', [user.id])).rows[0];
      return { data: await sessionTokens(db, user) };
    });
    if (outcome.error) throw outcome.error;
    res.json(outcome);
  });
  router.post('/resend-otp', async (req, res) => {
    const input = parse(z.object({ challengeId: id }).strict(), req.body);
    let newCode;
    const { row, user } = await transaction(pool, async (db) => {
      const found = await db.query('SELECT * FROM otp_challenges WHERE id=$1 FOR UPDATE', [input.challengeId]);
      const challenge = found.rows[0];
      if (!challenge || challenge.consumed_at || challenge.attempts >= 5 || challenge.times_sent >= 5) throw otpFailure();
      if (new Date(challenge.last_sent_at).getTime() + 60000 > now().getTime()) fail(429, 'OTP_COOLDOWN', 'Vui lòng chờ 60 giây trước khi gửi lại OTP.');
      const user = (await db.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [challenge.user_id])).rows[0];
      if (!user || user.status === 'suspended') throw otpFailure();
      do { newCode = otpCode(); } while (constantEqual(challenge.code_hash, otpHash(config.otpSecret, challenge.id, newCode)));
      const result = await db.query('UPDATE otp_challenges SET code_hash=$1,expires_at=$2,last_sent_at=$3,times_sent=times_sent+1 WHERE id=$4 RETURNING *',
        [otpHash(config.otpSecret, challenge.id, newCode), new Date(now().getTime() + 10 * 60000), now(), challenge.id]);
      return { row: result.rows[0], user };
    });
    await sendCode(row, user, newCode);
    res.json({ data: challengeView(row, user) });
  });
  router.post('/refresh', async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(32).max(200) }).strict(), req.body);
    const outcome = await transaction(pool, async (db) => {
      const found = await db.query('SELECT * FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE', [tokenHash(refreshToken)]);
      const token = found.rows[0];
      if (!token) return { error: loginFailure() };
      const session = (await db.query('SELECT * FROM sessions WHERE id=$1 FOR UPDATE', [token.session_id])).rows[0];
      if (token.consumed_at || new Date(token.expires_at) <= now()) {
        await db.query('UPDATE sessions SET revoked_at=$1 WHERE id=$2', [now(), token.session_id]);
        await db.query('DELETE FROM notification_devices WHERE session_id=$1', [token.session_id]);
        return { error: loginFailure() };
      }
      const user = (await db.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [session.user_id])).rows[0];
      if (session.revoked_at || !user || user.status === 'suspended') return { error: loginFailure() };
      await db.query('UPDATE refresh_tokens SET consumed_at=$1 WHERE id=$2', [now(), token.id]);
      return { data: await sessionTokens(db, user, session.id) };
    });
    if (outcome.error) throw outcome.error;
    res.json(outcome);
  });
  router.post('/logout', async (req, res) => {
    const { refreshToken } = parse(z.object({ refreshToken: z.string().min(32).max(200) }).strict(), req.body);
    await transaction(pool, async db => {
      await db.query('UPDATE sessions SET revoked_at=$1 WHERE id IN (SELECT session_id FROM refresh_tokens WHERE token_hash=$2)', [now(), tokenHash(refreshToken)]);
      await db.query('DELETE FROM notification_devices WHERE session_id IN (SELECT session_id FROM refresh_tokens WHERE token_hash=$1)', [tokenHash(refreshToken)]);
    });
    res.json({ data: { loggedOut: true } });
  });
  router.post('/face-login', rateLimit({ now, max: 15, windowMs: 5 * 60000 }), async (req, res) => {
    const input = parse(z.object({ username, imageBase64: z.string().min(16).max(2800000) }).strict(), req.body);
    const user = (await pool.query("SELECT * FROM users WHERE username=$1 AND status='active' AND email_verified=true AND deleted_at IS NULL", [input.username])).rows[0];
    if (!user) throw loginFailure();
    const face = (await pool.query('SELECT embedding FROM face_templates WHERE user_id=$1', [user.id])).rows[0];
    if (!face) throw loginFailure();
    const recognition = await loadFace();
    const probe = await recognition.extractEmbedding(input.imageBase64);
    if (!recognition.compareEmbeddings(face.embedding, probe).matches) throw loginFailure();
    const data = await transaction(pool, async db => {
      const current = (await db.query("SELECT * FROM users WHERE id=$1 AND status='active' AND email_verified=true AND deleted_at IS NULL FOR UPDATE", [user.id])).rows[0];
      if (!current) throw loginFailure();
      const currentFace = (await db.query('SELECT embedding FROM face_templates WHERE user_id=$1', [user.id])).rows[0];
      if (!currentFace || !recognition.compareEmbeddings(currentFace.embedding, probe).matches) throw loginFailure();
      return sessionTokens(db, current, undefined, 'face');
    });
    res.json({ data });
  });
  return { router, requireAuth, requireActive, issueSession: (db, user, method) => sessionTokens(db, user, undefined, method) };
}

export async function loadFace() {
  try { return await import('./face/recognizer.js'); }
  catch { fail(503, 'FACE_SERVICE_UNAVAILABLE', 'Bộ nhận diện khuôn mặt chưa sẵn sàng.'); }
}
