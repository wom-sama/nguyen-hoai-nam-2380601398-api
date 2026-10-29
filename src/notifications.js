import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z, id, parse } from './validation.js';
import { fail, transaction } from './security.js';
import { createFcmProvider, PushDeliveryError } from './fcm.js';

const deviceSchema = z.object({ installationId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  firebaseProjectId: z.string().min(6).max(30), platform: z.literal('android') }).strict();
const eventTypes = new Set(['shift_assigned', 'correction_reviewed', 'handover_submitted', 'profile_updated']);
const liveDevices = `SELECT DISTINCT d.* FROM notification_devices d JOIN users u ON u.id=d.user_id JOIN sessions s ON s.id=d.session_id AND s.user_id=u.id JOIN refresh_tokens r ON r.session_id=s.id
  WHERE u.status='active' AND u.email_verified=true AND u.deleted_at IS NULL AND s.revoked_at IS NULL AND r.consumed_at IS NULL AND r.expires_at>$1`;

export function createNotifications({ pool, config, now = () => new Date(), provider }) {
  const enabled = config.fcmEnabled === true;
  const sender = enabled ? (provider ?? createFcmProvider(config)) : null;
  const router = Router(); let running = false, stopped = false, timer;
  const shutdownWaiters = [];
  router.get('/notifications/status', (_req, res) => res.json({ data: { enabled, provider: 'fcm', firebaseProjectId: config.fcmProjectId ?? null } }));
  router.post('/notification-devices', async (req, res) => {
    if (!enabled) fail(503, 'PUSH_DISABLED', 'Thông báo chưa được cấu hình trên máy chủ.');
    const input = parse(deviceSchema, req.body);
    if (input.firebaseProjectId !== config.fcmProjectId) fail(422, 'PUSH_PROJECT_MISMATCH', 'Ứng dụng và máy chủ chưa dùng cùng dự án Firebase.');
    const device = await transaction(pool, async db => {
      const session = (await db.query('SELECT * FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.sessionId, req.user.id])).rows[0];
      const user = (await db.query('SELECT status,email_verified,deleted_at FROM users WHERE id=$1', [req.user.id])).rows[0];
      if (!session || session.revoked_at || user?.status !== 'active' || !user.email_verified || user.deleted_at) fail(401, 'SESSION_REVOKED', 'Phiên đăng nhập đã kết thúc.');
      const current = (await db.query('SELECT * FROM notification_devices WHERE installation_id=$1 FOR UPDATE', [input.installationId])).rows[0];
      if (current?.user_id === req.user.id && current.session_id === req.sessionId) return (await db.query('UPDATE notification_devices SET registered_at=$1 WHERE id=$2 RETURNING *', [now(), current.id])).rows[0];
      if (current) await db.query('DELETE FROM notification_devices WHERE id=$1', [current.id]);
      const devices = await db.query('SELECT id FROM notification_devices WHERE user_id=$1', [req.user.id]);
      if (devices.rows.length >= 10) fail(409, 'PUSH_DEVICE_LIMIT', 'Tài khoản đã liên kết tối đa 10 thiết bị. Hãy đăng xuất thiết bị cũ trước.');
      return (await db.query('INSERT INTO notification_devices(id,user_id,session_id,installation_id,platform,registered_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [randomUUID(), req.user.id, req.sessionId, input.installationId, input.platform, now()])).rows[0];
    });
    res.status(201).json({ data: { id: device.id, recipientId: device.user_id, installationId: device.installation_id, platform: device.platform, registeredAt: device.registered_at } });
  });
  router.delete('/notification-devices/:id', async (req, res) => {
    const deviceId = parse(id, req.params.id);
    const result = await pool.query('DELETE FROM notification_devices WHERE id=$1 AND user_id=$2 AND session_id=$3 RETURNING id', [deviceId, req.user.id, req.sessionId]);
    if (!result.rows.length) fail(404, 'NOT_FOUND', 'Không tìm thấy liên kết thiết bị trong phiên này.');
    res.json({ data: { deleted: true } });
  });
  async function enqueue(db, { type, entityId, version = 1, recipientId }) {
    if (!enabled) return;
    if (!eventTypes.has(type) || !id.safeParse(entityId).success || !id.safeParse(recipientId).success || !Number.isInteger(version) || version < 1) throw new Error('Invalid internal notification event.');
    if (type === 'profile_updated' && entityId !== recipientId) throw new Error('Invalid profile notification recipient.');
    const time = now();
    const devices = (await db.query(`${liveDevices} AND d.user_id=$2`, [time, recipientId])).rows;
    for (const device of devices) await db.query(`INSERT INTO notification_outbox(id,event_key,event_type,entity_id,entity_version,recipient_id,device_id,delivery_binding_id,available_at,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$8) ON CONFLICT(event_key,delivery_binding_id) DO NOTHING`,
    [randomUUID(), `${type}:${entityId}:${version}`, type, entityId, version, recipientId, device.id, time, new Date(time.getTime() + 24 * 3600000)]);
  }
  async function stillRelevant(event) {
    if (event.event_type === 'profile_updated') {
      if (event.entity_id !== event.recipient_id) return false;
      const row = (await pool.query('SELECT profile_version,status,email_verified,deleted_at FROM users WHERE id=$1', [event.entity_id])).rows[0];
      return row?.status === 'active' && row.email_verified && !row.deleted_at && row.profile_version === event.entity_version;
    }
    if (event.event_type === 'shift_assigned') {
      const row = (await pool.query('SELECT employee_id,assignment_version FROM shifts WHERE id=$1', [event.entity_id])).rows[0];
      return row?.employee_id === event.recipient_id && row.assignment_version === event.entity_version;
    }
    if (event.event_type === 'correction_reviewed') {
      const row = (await pool.query('SELECT employee_id,status FROM corrections WHERE id=$1', [event.entity_id])).rows[0];
      return row?.employee_id === event.recipient_id && ['approved','rejected'].includes(row.status);
    }
    const row = (await pool.query('SELECT recipient_id,status FROM handovers WHERE id=$1', [event.entity_id])).rows[0];
    if (row?.recipient_id !== event.recipient_id || row.status !== 'submitted') return false;
    // Recipient item updates also increment the row version. Compare submission
    // events, not the generic row version, when superseding an older author event.
    const newest = (await pool.query("SELECT entity_version FROM notification_outbox WHERE event_type='handover_submitted' AND entity_id=$1 ORDER BY entity_version DESC LIMIT 1", [event.entity_id])).rows[0];
    return !newest || newest.entity_version <= event.entity_version;
  }
  async function finish(event, status, code = null) {
    await pool.query('UPDATE notification_outbox SET status=$1,last_error_code=$2,completed_at=$3 WHERE id=$4', [status, code, now(), event.id]);
  }
  async function deliver(event) {
    if (new Date(event.expires_at) <= now()) return finish(event, 'skipped', 'EVENT_EXPIRED');
    const device = event.device_id && (await pool.query(`${liveDevices} AND d.id=$2 AND d.user_id=$3`, [now(), event.device_id, event.recipient_id])).rows[0];
    if (!device || !await stillRelevant(event)) return finish(event, 'skipped', 'BINDING_OR_EVENT_STALE');
    try {
      await sender.send(device.installation_id, event, { beforeSend: async () => {
        const current = (await pool.query(`${liveDevices} AND d.id=$2 AND d.user_id=$3`, [now(), event.device_id, event.recipient_id])).rows[0];
        return Boolean(current && current.installation_id === device.installation_id && await stillRelevant(event));
      } });
      await finish(event, 'sent');
    }
    catch (error) {
      const safe = error instanceof PushDeliveryError ? error : new PushDeliveryError('FCM_UNAVAILABLE', true);
      if (safe.code === 'FCM_BINDING_STALE') return finish(event, 'skipped', safe.code);
      if (safe.code === 'FCM_UNREGISTERED') await pool.query('DELETE FROM notification_devices WHERE id=$1', [device.id]);
      if (!safe.retryable || event.attempts >= 6) return finish(event, 'dead', safe.code);
      // At least one minute after quota errors; no immediate retry storm.
      const delay = Math.max(safe.retryAfterMs, Math.min(3600000, 60000 * 2 ** (event.attempts - 1)));
      await pool.query("UPDATE notification_outbox SET status='queued',last_error_code=$1,available_at=$2,claimed_at=NULL WHERE id=$3", [safe.code, new Date(now().getTime() + delay), event.id]);
    }
  }
  async function drain() {
    if (!enabled || running || stopped) return;
    running = true;
    try {
      const time = now();
      await pool.query(`DELETE FROM notification_devices WHERE session_id IN (SELECT id FROM sessions WHERE revoked_at IS NOT NULL)
        OR session_id NOT IN (SELECT session_id FROM refresh_tokens WHERE consumed_at IS NULL AND expires_at>$1)
        OR user_id IN (SELECT id FROM users WHERE status<>'active' OR email_verified=false OR deleted_at IS NOT NULL)`, [time]);
      await pool.query("DELETE FROM notification_outbox WHERE expires_at<$1", [new Date(time.getTime() - 6 * 86400000)]);
      await pool.query("UPDATE notification_outbox SET status='skipped',completed_at=$1,last_error_code='EVENT_EXPIRED' WHERE status='queued' AND expires_at<=$1", [time]);
      // Recover a process interrupted after claim. Provider calls are bounded at
      // 8s for OAuth + 10s for sending; the lease is deliberately longer.
      await pool.query("UPDATE notification_outbox SET status='queued',claimed_at=NULL WHERE status='processing' AND claimed_at<$1 AND attempts<6", [new Date(time.getTime() - 120000)]);
      await pool.query("UPDATE notification_outbox SET status='dead',completed_at=$1,last_error_code='RETRY_LIMIT' WHERE status='processing' AND claimed_at<$2 AND attempts>=6", [time, new Date(time.getTime() - 120000)]);
      const candidates = await pool.query("SELECT id FROM notification_outbox WHERE status='queued' AND available_at<=$1 AND expires_at>$1 AND attempts<6 ORDER BY available_at LIMIT 10", [time]);
      for (const candidate of candidates.rows) {
        if (stopped) break;
        const claimed = (await pool.query("UPDATE notification_outbox SET status='processing',attempts=attempts+1,claimed_at=$1 WHERE id=$2 AND status='queued' AND available_at<=$1 AND attempts<6 RETURNING *", [now(), candidate.id])).rows[0];
        if (claimed) await deliver(claimed);
      }
    } finally { running = false; for (const resolve of shutdownWaiters.splice(0)) resolve(); }
  }
  function kick() { if (enabled && !stopped && !running) setImmediate(() => { drain().catch(() => console.error('Hàng đợi thông báo tạm gián đoạn.')); }); }
  function start() { if (!enabled || timer) return; stopped = false; timer = setInterval(kick, 30000); timer.unref(); kick(); }
  function stop() { stopped = true; clearInterval(timer); timer = undefined;
    return running ? new Promise(resolve => shutdownWaiters.push(resolve)) : Promise.resolve(); }
  return { router, enabled, enqueue, drain, kick, start, stop };
}
