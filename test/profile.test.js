import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import express from 'express';
import request from 'supertest';
import { newDb } from 'pg-mem';
import { createProfile } from '../src/profile.js';
import { ApiError } from '../src/security.js';

let pool,app,mail,time,events,mailFailure,revokeAfterAuth;
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
beforeEach(async()=>{
  const db=newDb(); db.public.registerFunction({name:'length',args:['text'],returns:'integer',implementation:value=>value.length});
  const folder=new URL('../migrations/',import.meta.url);
  for(const file of(await readdir(folder)).filter(file=>/^\d+_.*\.sql$/.test(file)).sort()){
    let sql=await readFile(new URL(file,folder),'utf8');
    if(file==='001_initial.sql')sql=sql.replace('CHECK (radius_meters BETWEEN 20 AND 5000)','CONSTRAINT branches_radius_meters_check CHECK (radius_meters BETWEEN 20 AND 5000)');
    if(file==='003_push_notifications.sql')sql=sql.replace("CHECK (event_type IN ('shift_assigned','correction_reviewed','handover_submitted'))","CONSTRAINT notification_outbox_event_type_check CHECK (event_type IN ('shift_assigned','correction_reviewed','handover_submitted'))");
    db.public.none(sql);
  }
  const adapter=db.adapters.createPg();pool=new adapter.Pool();mail=[];events=[];mailFailure=false;revokeAfterAuth=false;time=Date.now();
  app=express();app.use(express.json({limit:'3mb'}));
  // This router's production authentication/active guards are owned by app.js.
  // The isolated fixture supplies their already-verified user contract.
  app.use(async(req,res,next)=>{
    const row=(await pool.query('SELECT * FROM users WHERE id=$1',[req.get('X-Test-User')??randomUUID()])).rows[0];
    if(!row)return res.status(401).json({error:{code:'AUTH_REQUIRED'}});
    if(row.status!=='active'||!row.email_verified)return res.status(403).json({error:{code:'ACCOUNT_PENDING'}});
    req.user=row;req.sessionId=(await pool.query('SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',[row.id])).rows[0]?.id;
    if(revokeAfterAuth)await pool.query('UPDATE sessions SET revoked_at=$1 WHERE id=$2',[new Date(time),req.sessionId]);
    next();
  });
  app.use('/v1',createProfile({pool,config:{otpSecret:'test-only-profile-secret-at-least-32-characters'},now:()=>new Date(time),
    mailer:{async sendOtp(message){mail.push(message);if(mailFailure&&mail.length%2===0)throw new Error('test provider failure');}},
    enqueueNotification:async(_db,event)=>events.push(event)}));
  app.use((error,_req,res,_next)=>res.status(error instanceof ApiError?error.status:500).json({error:{code:error.code??'INTERNAL_ERROR',message:error instanceof ApiError?error.message:'Internal test error'}}));
});
afterEach(async()=>pool.end());
async function user(role='employee'){
  const id=randomUUID();await pool.query("INSERT INTO users(id,full_name,username,email,password_hash,role,status,email_verified) VALUES($1,'Test Person',$2,$3,'unused-test-hash',$4,'active',true)",[id,`p${id.replaceAll('-','').slice(0,12)}`,`${id}@example.test`,role]);
  await pool.query('INSERT INTO sessions(id,user_id) VALUES($1,$2)',[randomUUID(),id]);
  return(await pool.query('SELECT * FROM users WHERE id=$1',[id])).rows[0];
}
const api=()=>request(app);
const as=u=>({'X-Test-User':u.id});
async function begin(u,newEmail='new-owner@example.test'){
  const response=await api().post('/v1/me/email-change').set(as(u)).send({newEmail});assert.equal(response.status,202);
  return{...response.body.data,oldCode:mail.at(-2).code,newCode:mail.at(-1).code};
}
async function prove(u,change){return api().post(`/v1/me/email-change/${change.requestId}/verify`).set(as(u)).send({oldCode:change.oldCode,newCode:change.newCode});}

test('own profile and appearance persist separately with bounded images, immutable identity and server version',async()=>{
  const a=await user(),b=await user();
  const initial=await api().get('/v1/me/profile').set(as(a));assert.equal(initial.status,200);
  assert.deepEqual(initial.body.data.appearance,{fontScale:1,textColor:'#402D37',primaryColor:'#AA496C',backgroundBase64:null});
  const changed=await api().patch('/v1/me/profile').set(as(a)).send({fullName:'Updated Name',phone:'0900123456',address:'Synthetic address',avatarBase64:png});
  assert.equal(changed.status,200);assert.equal(changed.body.data.profileVersion,2);assert.equal(changed.body.data.avatarBase64,png);
  const styled=await api().patch('/v1/me/appearance').set(as(a)).send({fontScale:1.4,textColor:'#aabbcc',primaryColor:'#112233',backgroundBase64:png});
  assert.equal(styled.status,200);assert.equal(styled.body.data.appearance.textColor,'#AABBCC');assert.equal(styled.body.data.profileVersion,3);
  assert.equal((await api().get('/v1/me/profile').set(as(b))).body.data.avatarBase64,null);
  assert.equal((await pool.query('SELECT * FROM users WHERE id=$1',[a.id])).rows[0].avatar_base64,undefined);
  assert.equal((await api().patch('/v1/me/profile').set(as(a)).send({username:'changed'})).status,422);
  assert.equal((await api().patch('/v1/me/profile').set(as(a)).send({email:'bypass@example.test'})).status,422);
  assert.ok(events.every(event=>event.recipientId===a.id&&event.type==='profile_updated'));
  const unchanged=await api().patch('/v1/me/appearance').set(as(a)).send({fontScale:1.4});assert.equal(unchanged.body.data.profileVersion,3);
});

test('image magic, canonical encoding, sizes and appearance bounds reject invalid values',async()=>{
  const a=await user();
  for(const avatarBase64 of['https://example.test/photo.png',`data:image/png;base64,${png}`,Buffer.from('<svg/>').toString('base64'),png+' ',Buffer.alloc(300*1024+1).toString('base64')])
    assert.equal((await api().patch('/v1/me/profile').set(as(a)).send({avatarBase64})).status,422);
  for(const body of[{fontScale:.79},{fontScale:1.61},{textColor:'red'},{primaryColor:'#12345678'},{backgroundBase64:Buffer.alloc(650*1024+1).toString('base64')}])
    assert.equal((await api().patch('/v1/me/appearance').set(as(a)).send(body)).status,422);
  assert.equal((await api().get('/v1/me/profile').set(as(a))).body.data.profileVersion,1);
});

test('dual email proof is context bound, own scoped, rate limited and extends admin approval to 24 hours',async()=>{
  const a=await user(),b=await user(),admin=await user('admin');const change=await begin(a);
  assert.equal(mail.at(-2).email,a.email);assert.equal(mail.at(-1).email,'new-owner@example.test');assert.ok(change.oldCode!==change.newCode);
  assert.equal((await api().post('/v1/me/email-change').set(as(a)).send({newEmail:'another@example.test'})).status,429);
  assert.equal((await api().get('/v1/me/email-change').set(as(b))).body.data,null);
  assert.equal((await prove(b,change)).status,404);
  assert.equal((await api().get('/v1/email-change-requests').set(as(admin))).body.data.length,0);
  const wrong=await api().post(`/v1/me/email-change/${change.requestId}/verify`).set(as(a)).send({oldCode:change.newCode,newCode:change.oldCode});
  assert.equal(wrong.status,422);assert.equal(wrong.body.error.code,'EMAIL_CHANGE_OTP_INVALID');
  const verified=await prove(a,change);assert.equal(verified.status,200);assert.equal(verified.body.data.status,'pending_approval');
  assert.equal(Date.parse(verified.body.data.expiresAt)-time,24*3600000);
  const pending=await api().get('/v1/email-change-requests').set(as(admin));assert.equal(pending.body.data.length,1);assert.equal(pending.body.data[0].userId,a.id);
  const stored=(await pool.query('SELECT * FROM email_change_requests WHERE id=$1',[change.requestId])).rows[0];
  assert.ok(stored.old_code_hash!==change.oldCode&&stored.new_code_hash!==change.newCode);
  assert.equal((await pool.query('SELECT email FROM users WHERE id=$1',[a.id])).rows[0].email,a.email);
});

test('only another active admin can approve proved email and approval revokes all authentication bindings',async()=>{
  const owner=await user('admin'),reviewer=await user('admin'),employee=await user();const change=await begin(owner);
  assert.equal((await prove(owner,change)).status,200);
  const route=`/v1/email-change-requests/${change.requestId}/review`;
  assert.equal((await api().post(route).set(as(owner)).send({decision:'approved'})).status,403);
  assert.equal((await api().post(route).set(as(employee)).send({decision:'approved'})).status,403);
  const sid=randomUUID();await pool.query('INSERT INTO sessions(id,user_id) VALUES($1,$2)',[sid,owner.id]);
  await pool.query("INSERT INTO notification_devices(id,user_id,session_id,installation_id,platform,registered_at) VALUES($1,$2,$3,'c000000000000000000001','android',$4)",[randomUUID(),owner.id,sid,new Date(time)]);
  await pool.query("INSERT INTO fingerprint_devices(id,user_id,device_id,public_key,key_algorithm,device_name,created_at) VALUES($1,$2,$3,'test-key','rsa-sha256','Test device',$4)",[randomUUID(),owner.id,randomUUID(),new Date(time)]);
  const fingerprintChallenge=randomUUID();
  await pool.query('INSERT INTO fingerprint_challenges(id,user_id,device_id,payload,expires_at) VALUES($1,$2,$3,$4,$5)',[fingerprintChallenge,owner.id,randomUUID(),'Synthetic test challenge',new Date(time+60000)]);
  const loginChallenge=randomUUID();
  await pool.query("INSERT INTO otp_challenges(id,user_id,purpose,code_hash,expires_at,last_sent_at) VALUES($1,$2,'login','test-hash',$3,$4)",[loginChallenge,owner.id,new Date(time+60000),new Date(time)]);
  const approved=await api().post(route).set(as(reviewer)).send({decision:'approved'});assert.equal(approved.status,200);
  const row=(await pool.query('SELECT * FROM users WHERE id=$1',[owner.id])).rows[0];assert.equal(row.email,'new-owner@example.test');assert.equal(row.email_verified,true);assert.equal(row.profile_version,2);
  assert.ok((await pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[sid])).rows[0].revoked_at);
  assert.equal((await pool.query('SELECT id FROM notification_devices WHERE user_id=$1',[owner.id])).rowCount,0);
  assert.ok((await pool.query('SELECT revoked_at FROM fingerprint_devices WHERE user_id=$1',[owner.id])).rows[0].revoked_at);
  assert.ok((await pool.query('SELECT consumed_at FROM fingerprint_challenges WHERE id=$1',[fingerprintChallenge])).rows[0].consumed_at);
  assert.ok((await pool.query('SELECT consumed_at FROM otp_challenges WHERE id=$1',[loginChallenge])).rows[0].consumed_at);
  assert.equal(approved.body.data.reviewedBy,reviewer.id);
  assert.equal((await api().post(route).set(as(reviewer)).send({decision:'approved'})).status,409);
});

test('expired codes, attempt cap and provider failure never change the email',async()=>{
  const a=await user();let change=await begin(a);
  time+=10*60000+1;assert.equal((await prove(a,change)).status,409);
  change=await begin(a,'second@example.test');
  const wrong=change.oldCode==='000000'?'111111':'000000';
  for(let i=0;i<5;i++)assert.equal((await api().post(`/v1/me/email-change/${change.requestId}/verify`).set(as(a)).send({oldCode:wrong,newCode:change.newCode})).status,i===4?429:422);
  assert.equal((await prove(a,change)).status,429);
  time+=61000;mailFailure=true;
  const failed=await api().post('/v1/me/email-change').set(as(a)).send({newEmail:'failed@example.test'});assert.equal(failed.status,503);
  assert.equal((await api().get('/v1/me/email-change').set(as(a))).body.data.status,'invalidated');
  assert.equal((await pool.query('SELECT email FROM users WHERE id=$1',[a.id])).rows[0].email,a.email);
});

test('an authenticated request revoked while waiting cannot start an email change or mutate the profile',async()=>{
  const a=await user();revokeAfterAuth=true;
  const start=await api().post('/v1/me/email-change').set(as(a)).send({newEmail:'revoked@example.test'});
  assert.equal(start.status,401);assert.equal(mail.length,0);
  assert.equal((await pool.query('SELECT id FROM email_change_requests')).rowCount,0);
  assert.equal((await api().patch('/v1/me/profile').set(as(a)).send({fullName:'Must Not Persist'})).status,401);
  assert.equal((await pool.query('SELECT full_name FROM users WHERE id=$1',[a.id])).rows[0].full_name,a.full_name);
});

test('review rechecks email uniqueness and old identity, and rejection preserves the user session',async()=>{
  const a=await user(),admin=await user('admin');let change=await begin(a);
  assert.equal((await prove(a,change)).status,200);
  const claimed=await user();await pool.query('UPDATE users SET email=$1 WHERE id=$2',['new-owner@example.test',claimed.id]);
  let reviewed=await api().post(`/v1/email-change-requests/${change.requestId}/review`).set(as(admin)).send({decision:'approved'});
  assert.equal(reviewed.status,409);assert.equal(reviewed.body.error.code,'EMAIL_ALREADY_IN_USE');
  assert.equal((await pool.query('SELECT email FROM users WHERE id=$1',[a.id])).rows[0].email,a.email);
  reviewed=await api().post(`/v1/email-change-requests/${change.requestId}/review`).set(as(admin)).send({decision:'rejected'});
  assert.equal(reviewed.status,200);assert.equal(reviewed.body.data.status,'rejected');
  assert.equal((await pool.query('SELECT revoked_at FROM sessions WHERE user_id=$1',[a.id])).rows[0].revoked_at,null);
  time+=61000;change=await begin(a,'next@example.test');assert.equal((await prove(a,change)).status,200);
  await pool.query('UPDATE users SET email=$1 WHERE id=$2',['changed-elsewhere@example.test',a.id]);
  reviewed=await api().post(`/v1/email-change-requests/${change.requestId}/review`).set(as(admin)).send({decision:'approved'});
  assert.equal(reviewed.status,409);assert.equal(reviewed.body.error.code,'EMAIL_CHANGE_STALE');
});

test('replacement invalidates prior proofs and admin approval expires after its 24-hour window',async()=>{
  const a=await user(),admin=await user('admin');const old=await begin(a);assert.equal((await prove(a,old)).status,200);
  time+=61000;const latest=await begin(a,'replacement@example.test');
  assert.equal((await api().post(`/v1/email-change-requests/${old.requestId}/review`).set(as(admin)).send({decision:'approved'})).status,409);
  assert.equal((await prove(a,latest)).status,200);time+=86400000+1;
  const reviewed=await api().post(`/v1/email-change-requests/${latest.requestId}/review`).set(as(admin)).send({decision:'approved'});
  assert.equal(reviewed.status,409);assert.equal(reviewed.body.error.code,'EMAIL_CHANGE_EXPIRED');
  assert.equal((await pool.query('SELECT email FROM users WHERE id=$1',[a.id])).rows[0].email,a.email);
});
