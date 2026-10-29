import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../src/security.js';

function hit(limiter, req) {
  const headers = {}; let error;
  limiter(req, { set(name, value) { headers[name] = value; } }, value => { error = value; });
  return { error, headers };
}

test('rate limiter defaults to IP and expires its fixed-window buckets', () => {
  let time = 0;
  const limiter = rateLimit({ max: 2, windowMs: 10000, now: () => new Date(time) });
  assert.equal(hit(limiter, { ip: 'shared', user: { id: 'a' } }).error, undefined);
  assert.equal(hit(limiter, { ip: 'shared', user: { id: 'b' } }).error, undefined);
  const denied = hit(limiter, { ip: 'shared', user: { id: 'c' } });
  assert.equal(denied.error.code, 'RATE_LIMITED'); assert.equal(denied.headers['Retry-After'], '10');
  assert.equal(hit(limiter, { ip: 'other' }).error, undefined);
  time = 10000;
  assert.equal(hit(limiter, { ip: 'shared' }).error, undefined);
});

test('rate limiter accepts an explicit account key across sessions and IP addresses', () => {
  const limiter = rateLimit({ max: 2, key: req => req.user.id, now: () => new Date(0) });
  const req = (id, ip = 'shared') => ({ ip, user: { id } });
  assert.equal(hit(limiter, req('a')).error, undefined);
  assert.equal(hit(limiter, req('b')).error, undefined);
  assert.equal(hit(limiter, req('a', 'changed-ip')).error, undefined);
  assert.equal(hit(limiter, req('a')).error?.code, 'RATE_LIMITED');
  assert.equal(hit(limiter, req('b')).error, undefined);
});

