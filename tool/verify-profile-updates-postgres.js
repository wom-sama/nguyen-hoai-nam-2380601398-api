// Opt-in integration: only a unique owned schema is changed; no email/FCM calls.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { databaseOptions } from '../src/config.js';
import { applyMigrations } from '../src/migrate.js';
import { transaction } from '../src/security.js';
import { createNotifications } from '../src/notifications.js';

const schema = `test_so_ca_hn_profile_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^test_so_ca_hn_profile_[a-f0-9]{32}$/);
const options = databaseOptions();
assert.equal(options.ssl?.rejectUnauthorized, true, 'Verified PostgreSQL TLS is required.');
const control = new pg.Pool({ ...options, max: 1 });
let pool, notifications, created = false, stage = 'connect', checks = 0, failure = false, cleanup = false;
const passed = name => { checks++; console.log(`PASS ${name}`); };
try {
  assert.equal((await control.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0]?.ssl, true);
  await control.query(`CREATE SCHEMA "${schema}"`); created = true;
  pool = new pg.Pool({ ...options, max: 2, options: `-c search_path=${schema}` });
  assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
  passed('verified TLS and isolated search_path');
  stage = 'baseline';
  await pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  const folder = new URL('../migrations/', import.meta.url);
  const files = (await readdir(folder)).filter(file => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort();
  assert.ok(files.includes('007_profile_update_notifications.sql'));
  for (const file of files.filter(file => file < '007_')) {
    const sql = await readFile(new URL(file, folder), 'utf8'); await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [file, createHash('sha256').update(sql).digest('hex')]);
  }
  const userId = randomUUID(), sessionId = randomUUID(), deviceId = randomUUID();
  await pool.query("INSERT INTO users(id,full_name,username,email,password_hash,role,status,email_verified) VALUES($1,'Synthetic profile test','profile_test','profile@example.test','not-a-login-password','employee','active',true)", [userId]);
  stage = 'migration'; await applyMigrations(pool); await applyMigrations(pool);
  assert.equal((await pool.query('SELECT profile_version FROM users WHERE id=$1', [userId])).rows[0].profile_version, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, files.length);
  passed('migration 007 upgrades existing users and repeats safely');
  await pool.query('INSERT INTO sessions(id,user_id) VALUES($1,$2)', [sessionId, userId]);
  await pool.query('INSERT INTO refresh_tokens(id,session_id,token_hash,expires_at) VALUES($1,$2,$3,$4)', [randomUUID(), sessionId, randomUUID(), new Date(Date.now() + 3600000)]);
  await pool.query("INSERT INTO notification_devices(id,user_id,session_id,installation_id,platform,registered_at) VALUES($1,$2,$3,'c000000000000000000001','android',$4)", [deviceId, userId, sessionId, new Date()]);
  const sent = [];
  notifications = createNotifications({ pool, config: { fcmEnabled: true }, provider: { async send(_fid, event) { sent.push(event); } } });
  const change = () => transaction(pool, async db => {
    const row = (await db.query('UPDATE users SET profile_version=profile_version+1 WHERE id=$1 RETURNING profile_version', [userId])).rows[0];
    await notifications.enqueue(db, { type: 'profile_updated', entityId: userId, recipientId: userId, version: row.profile_version });
  });
  stage = 'rollback';
  await assert.rejects(transaction(pool, async db => {
    await db.query('UPDATE users SET profile_version=profile_version+1 WHERE id=$1', [userId]);
    await notifications.enqueue(db, { type: 'profile_updated', entityId: userId, recipientId: userId, version: 2 });
    throw new Error('Expected test rollback');
  }), /Expected test rollback/);
  assert.equal((await pool.query('SELECT profile_version FROM users WHERE id=$1', [userId])).rows[0].profile_version, 1);
  assert.equal((await pool.query('SELECT id FROM notification_outbox')).rowCount, 0);
  passed('profile version and queued notification roll back together');
  stage = 'delivery'; await change(); await change();
  assert.equal((await pool.query('SELECT id FROM notification_outbox')).rowCount, 2);
  await notifications.drain();
  assert.equal(sent.length, 1); assert.equal(sent[0].entity_version, 3); assert.equal(sent[0].recipient_id, userId);
  assert.deepEqual((await pool.query('SELECT status FROM notification_outbox ORDER BY entity_version')).rows.map(row => row.status), ['skipped','sent']);
  passed('real PostgreSQL accepts profile events and skips superseded versions');
  stage = 'constraint';
  await assert.rejects(pool.query("UPDATE notification_outbox SET event_type='unknown_event'"), error => error.code === '23514');
  passed('event CHECK still rejects unrecognized types');
} catch (error) {
  failure = true; console.error(JSON.stringify({ status: 'failed', stage, code: /^[A-Z0-9_]{1,40}$/.test(error.code ?? '') ? error.code : 'CHECK_FAILED' }));
} finally {
  await notifications?.stop(); await pool?.end();
  try {
    if (created) {
      assert.match(schema, /^test_so_ca_hn_profile_[a-f0-9]{32}$/);
      const owner = (await control.query('SELECT nspname,pg_get_userbyid(nspowner)=current_user AS owned FROM pg_namespace WHERE nspname=$1', [schema])).rows[0];
      assert.equal(owner?.nspname, schema); assert.equal(owner.owned, true);
      await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      assert.equal((await control.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
      cleanup = true; passed('exact owned test schema removed');
    }
  } catch { failure = true; console.error(JSON.stringify({ status: 'failed', stage: 'cleanup', code: 'CLEANUP_FAILED' })); }
  await control.end(); console.log(JSON.stringify({ status: failure ? 'failed' : 'passed', checks, cleanup }));
  if (failure) process.exitCode = 1;
}
