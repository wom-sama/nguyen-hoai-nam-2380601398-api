import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createApp} from '../src/app.js';
const app=createApp({pool:{query:async()=>({rows:[]})},config:{jwtSecret:'x'.repeat(40),otpSecret:'y'.repeat(40)},mailer:{sendOtp:async()=>{}}});
test('Swagger UI and its local assets are public while business routes stay authenticated',async()=>{
 const page=await request(app).get('/v1/index.html');assert.equal(page.status,200);assert.match(page.headers['content-type'],/text\/html/);assert.match(page.text,/swagger-ui-bundle/);assert.match(page.headers['content-security-policy'],/connect-src 'self'/);
 for(const path of ['/v1/docs-assets/swagger-ui.css','/v1/docs-assets/swagger-ui-bundle.js','/v1/docs-init.js','/v1/docs-style.css'])assert.equal((await request(app).get(path)).status,200);
 assert.equal((await request(app).get('/v1/employees')).status,401);assert.equal((await request(app).get('/v1/me')).status,401);assert.equal((await request(app).get('/v1/docs-assets/package.json')).status,404);
});
test('OpenAPI documents real login, OTP, CRUD and bearer authorization with same-origin server only',async()=>{
 const r=await request(app).get('/v1/openapi.json');assert.equal(r.status,200);const d=r.body;assert.equal(d.openapi,'3.0.3');assert.deepEqual(d.servers.map(s=>s.url),['/v1']);assert.equal(d.components.securitySchemes.bearerAuth.scheme,'bearer');assert.deepEqual(d.paths['/auth/login'].post.security,[]);for(const p of ['/employees','/branches','/shifts','/corrections'])for(const method of ['get','post'])assert.ok(d.paths[p][method]);assert.ok(d.paths['/auth/verify-otp'].post.requestBody);assert.ok(!JSON.stringify(d).includes('BEGIN PRIVATE KEY'));
 const js=(await request(app).get('/v1/docs-init.js')).text;assert.match(js,/persistAuthorization:false/);assert.match(js,/queryConfigEnabled:false/);assert.match(js,/target.origin!==location.origin/);
});
