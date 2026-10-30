import express from 'express';
import { ApiError, publicUser, rateLimit } from './security.js';
import { createAuth } from './auth.js';
import { createResources } from './resources.js';
import { createNotifications } from './notifications.js';
import { createCameraTranslations } from './camera-translations.js';
import { createFingerprint } from './fingerprint.js';
import { createProfile } from './profile.js';

export function createApp({ pool, config, mailer, now = () => new Date(), pushProvider, autoStartNotifications = false }) {
  const app = express();
  const notifications = createNotifications({ pool, config, now, provider: pushProvider });
  app.locals.notifications = notifications;
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === true ? 1 : false);
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    next();
  });
  const auth = createAuth({ pool, config, mailer, now });
  const fingerprint = createFingerprint({ pool, config, now, issueSession: auth.issueSession });
  const failedProfileAuth = rateLimit({ now, max: 500 });
  // Profile polling has a bounded pre-auth IP gate and, after JWT/session
  // verification, a user budget shared across that user's devices and IPs.
  app.get('/v1/me', rateLimit({ now, max: 3600 }), (req, res, next) =>
    auth.requireAuth(req, res, error => {
      if (error) return failedProfileAuth(req, res, limitError => next(limitError ?? error));
      next();
    }), rateLimit({ now, max: 180, key: req => req.user.id }),
  (req, res) => res.json({ data: publicUser(req.user) }));
  app.use(rateLimit({ now, max: 500 }));
  app.use(express.json({ limit: '3mb', strict: true }));
  if (autoStartNotifications) app.use((req, res, next) => {
    if (['POST','PATCH'].includes(req.method)) res.once('finish', () => { if (res.statusCode < 400) notifications.kick(); });
    next();
  });
  app.get(['/health','/v1/health'], async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ data: { status: 'ok', service: 'attendance-api' } }); }
    catch { res.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Cơ sở dữ liệu chưa sẵn sàng.' } }); }
  });
  app.use('/v1/auth', auth.router);
  app.use('/v1/auth', fingerprint.publicRouter);
  app.use('/v1', auth.requireAuth, auth.requireActive, notifications.router, createCameraTranslations({pool,now}),
    fingerprint.privateRouter, createProfile({ pool, config, mailer, now, enqueueNotification: notifications.enqueue }),
    createResources({ pool, now, timeZone: config.timeZone, enqueueNotification: notifications.enqueue }));
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy API.' } }));
  app.use((error, _req, res, _next) => {
    if (error instanceof ApiError) return res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    if (error.name === 'FaceRecognitionError' && error.expose === true && [422,429,503].includes(error.status) && /^FACE_[A-Z_]+$/.test(error.code)) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Ảnh hoặc nội dung gửi lên quá lớn.' } });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'JSON_INVALID', message: 'Dữ liệu JSON không hợp lệ.' } });
    if (error.code === '23505') return res.status(409).json({ error: { code: 'RECORD_EXISTS', message: 'Dữ liệu này đã tồn tại. Vui lòng tải lại và kiểm tra.' } });
    if (error.code === '23503') return res.status(409).json({ error: { code: 'RECORD_IN_USE', message: 'Dữ liệu đang được tham chiếu. Hãy kiểm tra các ca làm và hồ sơ liên quan.' } });
    if (error.code === '23514' || error.code === '22P02') return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Dữ liệu không đáp ứng điều kiện của hệ thống.' } });
    // Logs intentionally omit request bodies, OTP, bearer tokens, faces and database errors.
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Có lỗi hệ thống. Vui lòng thử lại sau.' } });
  });
  return app;
}
