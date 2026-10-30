import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { newDb } from 'pg-mem';
import { createFingerprint } from '../src/fingerprint.js';

let pool, app, userId, sessionId, deviceId, timestamp, method, age, sessions;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' });
beforeEach(async () => {
  const db = newDb();
  db.public.none(`CREATE TABLE users(id uuid PRIMARY KEY,username text,status text,email_verified boolean,deleted_at timestamptz);
    CREATE TABLE sessions(id uuid PRIMARY KEY,user_id uuid,created_at timestamptz,revoked_at timestamptz);`);
  db.public.none(await readFile(new URL('../migrations/009_biometric_devices.sql', import.meta.url), 'utf8'));
  pool = new (db.adapters.createPg().Pool)();
  userId = randomUUID(); deviceId = randomUUID(); timestamp = Date.now(); method = 'password_otp'; age = 0; sessions = [];
  sessionId = randomUUID();
  await pool.query("INSERT INTO users VALUES($1,'nam','active',true,NULL)", [userId]);
  await pool.query('INSERT INTO sessions(id,user_id,created_at) VALUES($1,$2,$3)', [sessionId, userId, new Date(timestamp)]);
  const routes = createFingerprint({ pool, config: { issuer: 'test-api' }, now: () => new Date(timestamp), issueSession: async (_db, user, authMethod) => {
    sessions.push(authMethod); return { accessToken: 'test-access', refreshToken: 'test-refresh', user: { id: user.id } };
  }});
  app = express(); app.use(express.json()); app.use('/v1/auth', routes.publicRouter);
  app.use('/v1', (req, _res, next) => { req.user = { id: userId, username: 'nam' }; req.sessionId = sessionId; next(); }, routes.privateRouter);
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: { code: err.code ?? 'INTERNAL' } }));
});
afterEach(() => pool.end());
async function enroll(publicKey = pem) {
  await pool.query('UPDATE sessions SET auth_method=$1,created_at=$2 WHERE id=$3', [method, new Date(timestamp-age), sessionId]);
  return request(app).post('/v1/fingerprint/enroll').send({ deviceId, publicKey, deviceName: 'Test Android' });
}
async function challenge() { return request(app).post('/v1/auth/fingerprint/challenge').send({ username: 'nam', deviceId }); }
function signed(row, changes = {}) { return { username: 'nam', deviceId, challengeId: row.challengeId, signature: sign('sha256', Buffer.from(row.payload), keys.privateKey).toString('base64'), ...changes }; }

test('RSA challenge proof issues a direct fingerprint session once, without OTP', async () => {
  assert.equal((await enroll()).status, 201);
  const c = await challenge(); assert.equal(c.status, 200);
  const proof = signed(c.body.data);
  const success = await request(app).post('/v1/auth/fingerprint/verify').send(proof);
  assert.equal(success.status, 200); assert.equal(success.body.data.accessToken, 'test-access');
  assert.equal(success.body.data.challengeId, undefined); assert.deepEqual(sessions, ['fingerprint']);
  assert.equal((await request(app).post('/v1/auth/fingerprint/verify').send(proof)).status, 401);
});
test('enrollment requires fresh password plus OTP, not a face/fingerprint or old session', async () => {
  method = 'face'; assert.equal((await enroll()).status, 403);
  method = 'fingerprint'; assert.equal((await enroll()).status, 403);
  method = 'password_otp'; age = 15 * 60000 + 1; assert.equal((await enroll()).status, 403);
});
test('wrong-device proof is rejected and cannot issue a session', async () => {
  await enroll(); const c = await challenge();
  assert.equal((await request(app).post('/v1/auth/fingerprint/verify').send(signed(c.body.data, { deviceId: randomUUID() }))).status, 401);
  assert.deepEqual(sessions, []);
});
test('inactive user, revoked binding and expired nonce cannot authenticate', async () => {
  await enroll(); const c = await challenge();
  await pool.query("UPDATE users SET status='suspended' WHERE id=$1", [userId]);
  assert.equal((await request(app).post('/v1/auth/fingerprint/verify').send(signed(c.body.data))).status, 401);
  await pool.query("UPDATE users SET status='active' WHERE id=$1", [userId]);
  const c2 = await challenge(); timestamp += 120001;
  assert.equal((await request(app).post('/v1/auth/fingerprint/verify').send(signed(c2.body.data))).status, 401);
  const c3 = await challenge(); await pool.query('UPDATE fingerprint_devices SET revoked_at=$1 WHERE user_id=$2', [new Date(timestamp), userId]);
  assert.equal((await request(app).post('/v1/auth/fingerprint/verify').send(signed(c3.body.data))).status, 401);
  assert.deepEqual(sessions, []);
});
test('five invalid signatures consume the attempt budget, including after a valid proof arrives', async () => {
  await enroll(); const c = await challenge();
  const bad = signed(c.body.data, { signature: Buffer.alloc(256, 1).toString('base64') });
  for (let i = 0; i < 5; i++) assert.equal((await request(app).post('/v1/auth/fingerprint/verify').send(bad)).status, 401);
  assert.equal((await request(app).post('/v1/auth/fingerprint/verify').send(signed(c.body.data))).status, 401);
  assert.equal((await pool.query('SELECT attempts FROM fingerprint_challenges WHERE id=$1', [c.body.data.challengeId])).rows[0].attempts, 5);
});
test('malformed, weak and unsupported public keys are rejected before registration', async () => {
  assert.equal((await enroll('not a key')).status, 422);
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal((await enroll(weak)).status, 422);
  const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal((await enroll(wrongCurve)).status, 422);
});
test('device revoke is owner-scoped and invalidates outstanding proof', async () => {
  const registration = await enroll(); const c = await challenge();
  const previous = userId; userId = randomUUID();
  assert.equal((await request(app).delete(`/v1/fingerprint/devices/${registration.body.data.id}`)).status, 404);
  userId = previous;
  assert.equal((await request(app).delete(`/v1/fingerprint/devices/${registration.body.data.id}`)).status, 200);
  assert.equal((await request(app).post('/v1/auth/fingerprint/verify').send(signed(c.body.data))).status, 401);
});
test('P-256 proof verifies against the stored context-bound nonce', async () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.equal((await enroll(ec.publicKey.export({ type: 'spki', format: 'pem' }))).status, 201);
  const c = await challenge(); const row = c.body.data;
  const proof = { username: 'nam', deviceId, challengeId: row.challengeId,
    signature: sign('sha256', Buffer.from(row.payload), ec.privateKey).toString('base64') };
  assert.equal((await request(app).post('/v1/auth/fingerprint/verify').send(proof)).status, 200);
});
test('a newer nonce invalidates the previous nonce; replacing a binding invalidates its pending proof', async () => {
  await enroll(); const old = await challenge(); await challenge();
  assert.equal((await request(app).post('/v1/auth/fingerprint/verify').send(signed(old.body.data))).status, 401);
  const pending = await challenge(); await enroll();
  assert.equal((await request(app).post('/v1/auth/fingerprint/verify').send(signed(pending.body.data))).status, 401);
});
test('status preflight exposes fresh-session eligibility before the OS creates a key', async () => {
  const status = () => request(app).get('/v1/fingerprint/status').query({ deviceId });
  assert.equal((await status()).body.data.canEnroll, true);
  await pool.query("UPDATE sessions SET auth_method='face' WHERE id=$1", [sessionId]);
  assert.equal((await status()).body.data.canEnroll, false);
});

test('reactivating a revoked binding cannot exceed the active device limit', async () => {
  await enroll();
  const oldDevice = deviceId;
  await pool.query('UPDATE fingerprint_devices SET revoked_at=$1 WHERE user_id=$2', [new Date(timestamp), userId]);
  for (let i = 0; i < 10; i++) { deviceId = randomUUID(); assert.equal((await enroll()).status, 201); }
  deviceId = oldDevice;
  const response = await enroll();
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'FINGERPRINT_DEVICE_LIMIT');
});
