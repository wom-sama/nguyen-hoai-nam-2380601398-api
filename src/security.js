import { randomBytes, randomInt, createHash, createHmac, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync = promisify(scrypt);
export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
export const fail = (status, code, message, details) => { throw new ApiError(status, code, message, details); };
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt}$${key.toString('hex')}`;
}
export async function checkPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '16384' || parts[2] !== '8' || parts[3] !== '1' || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false;
  const expected = Buffer.from(parts[5], 'hex');
  const actual = await scryptAsync(password, parts[4], 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}
export const opaqueToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const otpCode = () => randomInt(0, 1000000).toString().padStart(6, '0');
export const otpHash = (secret, id, code) => createHmac('sha256', secret).update(`${id}:${code}`).digest('hex');
export function constantEqual(left, right) {
  const a = Buffer.from(left, 'utf8'), b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
export function publicUser(row) {
  return { id: row.id, fullName: row.full_name, username: row.username, email: row.email, role: row.role,
    status: row.status, branchId: row.branch_id, createdAt: row.created_at, emailVerified: row.email_verified,
    profileVersion: row.profile_version ?? 1 };
}
export async function transaction(pool, action) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export function rateLimit({ windowMs = 15 * 60000, max = 100, now = () => new Date(), key = req => req.ip } = {}) {
  const buckets = new Map();
  let nextSweep = 0;
  return (req, res, next) => {
    const time = now().getTime();
    if (time >= nextSweep) { for (const [key, bucket] of buckets) if (bucket.until <= time) buckets.delete(key); nextSweep = time + 60000; }
    const bucketKey = key(req);
    const bucket = buckets.get(bucketKey) ?? { count: 0, until: time + windowMs };
    if (bucket.until <= time) { bucket.count = 0; bucket.until = time + windowMs; }
    bucket.count++; buckets.set(bucketKey, bucket);
    if (bucket.count > max) { res.set('Retry-After', String(Math.ceil((bucket.until - time) / 1000))); return next(new ApiError(429, 'RATE_LIMITED', 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.')); }
    next();
  };
}
