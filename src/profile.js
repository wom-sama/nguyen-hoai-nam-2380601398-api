import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z, name, email, id, parse } from './validation.js';
import { ApiError, fail, transaction, otpCode, otpHash, constantEqual } from './security.js';

const defaults={phone:'',address:'',avatar_base64:null,font_scale:1,text_color:'#402D37',primary_color:'#AA496C',background_base64:null};
const image = limit => z.string().refine(value=>{
  // Decode bounded base64 bytes only; never decode pixels or fetch remote URLs.
  if(!value.length||value.length>Math.ceil(limit/3)*4||value.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))return false;
  const bytes=Buffer.from(value,'base64');
  if(bytes.length>limit||bytes.toString('base64')!==value)return false;
  const png=bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.subarray(12,16).toString('ascii')==='IHDR'&&bytes.subarray(-8).equals(Buffer.from([73,69,78,68,174,66,96,130]));
  const jpeg=bytes.length>=12&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217;
  return png||jpeg;
},'Chỉ nhận ảnh PNG/JPEG base64 nguyên bản trong giới hạn kích thước.').nullable();
const ownSchema=z.object({fullName:name.optional(),phone:z.string().trim().max(30).optional(),address:z.string().trim().max(500).optional(),avatarBase64:image(300*1024).optional()}).strict();
const color=z.string().regex(/^#[0-9a-fA-F]{6}$/).transform(value=>value.toUpperCase());
const appearanceSchema=z.object({fontScale:z.number().finite().min(.8).max(1.6).optional(),textColor:color.optional(),primaryColor:color.optional(),backgroundBase64:image(650*1024).optional()}).strict();
const requestSelect='SELECT e.*,u.full_name,u.username FROM email_change_requests e JOIN users u ON u.id=e.user_id';
const notFound=()=>fail(404,'NOT_FOUND','Không tìm thấy yêu cầu trong phạm vi của bạn.');
const error=(status,code,message,details)=>new ApiError(status,code,message,details);
const mask=address=>{const[local,domain]=address.split('@');return`${local.slice(0,Math.min(2,local.length))}***@${domain}`;};

export function createProfile({pool,config,mailer,now=()=>new Date(),enqueueNotification=async()=>{}}){
  const router=Router();
  async function currentUser(db,req){
    const user=(await db.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0]??notFound();
    if(user.deleted_at||user.status!=='active'||!user.email_verified)fail(403,'ACCOUNT_PENDING','Tài khoản không còn đủ điều kiện thực hiện thay đổi.');
    if(!id.safeParse(req.sessionId).success)fail(401,'SESSION_REVOKED','Phiên đăng nhập đã kết thúc.');
    const session=(await db.query('SELECT id,revoked_at FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.sessionId,user.id])).rows[0];
    if(!session||session.revoked_at)fail(401,'SESSION_REVOKED','Phiên đăng nhập đã kết thúc.');
    return user;
  }
  async function profile(db,userId){
    const user=(await db.query('SELECT id,full_name,username,email,profile_version FROM users WHERE id=$1',[userId])).rows[0]??notFound();
    const settings={...defaults,...(await db.query('SELECT * FROM user_profile_settings WHERE user_id=$1',[userId])).rows[0]};
    return{fullName:user.full_name,username:user.username,email:user.email,phone:settings.phone,address:settings.address,avatarBase64:settings.avatar_base64,
      appearance:{fontScale:settings.font_scale,textColor:settings.text_color,primaryColor:settings.primary_color,backgroundBase64:settings.background_base64},profileVersion:user.profile_version};
  }
  function view(row){
    const expired=['pending_verification','pending_approval'].includes(row.status)&&new Date(row.expires_at)<=now();
    return{requestId:row.id,userId:row.user_id,fullName:row.full_name,username:row.username,oldEmail:row.old_email,newEmail:row.new_email,
      maskedOldEmail:mask(row.old_email),maskedNewEmail:mask(row.new_email),status:expired?'expired':row.status,createdAt:row.created_at,expiresAt:row.expires_at,
      verifiedAt:row.verified_at,reviewedAt:row.reviewed_at,reviewedBy:row.reviewed_by,retryAfterSeconds:Math.max(0,Math.ceil((new Date(row.created_at).getTime()+60000-now().getTime())/1000))};
  }
  async function requestRow(db,requestId,locking=false){return(await db.query(`SELECT * FROM email_change_requests WHERE id=$1${locking?' FOR UPDATE':''}`,[requestId])).rows[0]??notFound();}
  async function detailed(db,requestId){return view((await db.query(`${requestSelect} WHERE e.id=$1`,[requestId])).rows[0]??notFound());}
  async function checkPending(db,row,status){
    if(row.status!==status)return error(409,'EMAIL_CHANGE_NOT_PENDING','Yêu cầu này không còn ở bước hiện tại.');
    if(new Date(row.expires_at)<=now()){
      await db.query("UPDATE email_change_requests SET status='expired' WHERE id=$1",[row.id]);
      return error(409,'EMAIL_CHANGE_EXPIRED','Yêu cầu đã hết hạn. Vui lòng tạo yêu cầu mới.');
    }
    return null;
  }
  function admin(user){if(user.role!=='admin')fail(403,'FORBIDDEN','Chỉ quản trị viên được duyệt đổi email.');}
  router.get('/me/profile',async(req,res)=>res.json({data:await profile(pool,req.user.id)}));
  async function save(req,res,schema){
    const input=parse(schema,req.body);if(!Object.keys(input).length)fail(422,'EMPTY_UPDATE','Chưa có nội dung cập nhật.');
    const result=await transaction(pool,async db=>{
      const user=await currentUser(db,req);
      const settings={...defaults,...(await db.query('SELECT * FROM user_profile_settings WHERE user_id=$1',[user.id])).rows[0]};
      const mapping={phone:'phone',address:'address',avatarBase64:'avatar_base64',fontScale:'font_scale',textColor:'text_color',primaryColor:'primary_color',backgroundBase64:'background_base64'};
      const changed=Object.entries(input).some(([key,value])=>value!==(key==='fullName'?user.full_name:settings[mapping[key]]));
      if(!changed)return profile(db,user.id);
      for(const[key,value]of Object.entries(input))if(mapping[key])settings[mapping[key]]=value;
      if(input.fullName!==undefined)await db.query('UPDATE users SET full_name=$1 WHERE id=$2',[input.fullName,user.id]);
      await db.query(`INSERT INTO user_profile_settings(user_id,phone,address,avatar_base64,font_scale,text_color,primary_color,background_base64) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(user_id) DO UPDATE SET phone=EXCLUDED.phone,address=EXCLUDED.address,avatar_base64=EXCLUDED.avatar_base64,font_scale=EXCLUDED.font_scale,text_color=EXCLUDED.text_color,primary_color=EXCLUDED.primary_color,background_base64=EXCLUDED.background_base64`,
      [user.id,settings.phone,settings.address,settings.avatar_base64,settings.font_scale,settings.text_color,settings.primary_color,settings.background_base64]);
      const updated=(await db.query('UPDATE users SET profile_version=profile_version+1 WHERE id=$1 RETURNING profile_version',[user.id])).rows[0];
      await enqueueNotification(db,{type:'profile_updated',entityId:user.id,recipientId:user.id,version:updated.profile_version});
      return profile(db,user.id);
    });
    res.json({data:result});
  }
  router.patch('/me/profile',(req,res)=>save(req,res,ownSchema));
  router.patch('/me/appearance',(req,res)=>save(req,res,appearanceSchema));
  router.post('/me/email-change',async(req,res)=>{
    const{newEmail}=parse(z.object({newEmail:email}).strict(),req.body);let oldCode,newCode;
    const row=await transaction(pool,async db=>{
      const user=await currentUser(db,req);
      if(newEmail===user.email)fail(422,'EMAIL_UNCHANGED','Email mới trùng email hiện tại.');
      const latest=(await db.query('SELECT created_at FROM email_change_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[user.id])).rows[0];
      const retry=latest?Math.ceil((new Date(latest.created_at).getTime()+60000-now().getTime())/1000):0;
      if(retry>0)fail(429,'EMAIL_CHANGE_COOLDOWN','Vui lòng chờ trước khi yêu cầu hai mã mới.',{retryAfterSeconds:retry});
      if((await db.query('SELECT id FROM users WHERE email=$1',[newEmail])).rows.length)fail(409,'EMAIL_ALREADY_IN_USE','Email mới đã được dùng cho tài khoản khác.');
      await db.query("UPDATE email_change_requests SET status='invalidated' WHERE user_id=$1 AND status IN ('pending_verification','pending_approval')",[user.id]);
      const requestId=randomUUID(),time=now();oldCode=otpCode();do{newCode=otpCode();}while(newCode===oldCode);
      const context=`email-change:${requestId}:${user.email}:${newEmail}`;
      return(await db.query(`INSERT INTO email_change_requests(id,user_id,old_email,new_email,old_code_hash,new_code_hash,created_at,otp_expires_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,[requestId,user.id,user.email,newEmail,otpHash(config.otpSecret,`${context}:old`,oldCode),otpHash(config.otpSecret,`${context}:new`,newCode),time,new Date(time.getTime()+600000)])).rows[0];
    });
    // Generic verification transport already accepted by the deployed relay.
    // The hashes above are distinct from login OTPs and from one another.
    const sends=await Promise.allSettled([mailer.sendOtp({email:row.old_email,fullName:req.user.full_name,code:oldCode,purpose:'login'}),mailer.sendOtp({email:row.new_email,fullName:req.user.full_name,code:newCode,purpose:'login'})]);
    if(sends.some(item=>item.status==='rejected')){
      await pool.query("UPDATE email_change_requests SET status='invalidated' WHERE id=$1",[row.id]);
      fail(503,'EMAIL_UNAVAILABLE','Chưa gửi thành công cả hai email. Yêu cầu đã hủy; vui lòng thử lại sau.');
    }
    const ready=await pool.query("UPDATE email_change_requests SET delivery_confirmed=true WHERE id=$1 AND status='pending_verification' RETURNING id",[row.id]);
    if(!ready.rows.length)fail(409,'EMAIL_CHANGE_NOT_PENDING','Yêu cầu đã được thay thế.');
    res.status(202).json({data:{requestId:row.id,maskedOldEmail:mask(row.old_email),maskedNewEmail:mask(row.new_email),status:row.status,expiresAt:row.expires_at,retryAfterSeconds:60}});
  });
  router.get('/me/email-change',async(req,res)=>{
    const row=(await pool.query(`${requestSelect} WHERE e.user_id=$1 ORDER BY e.created_at DESC LIMIT 1`,[req.user.id])).rows[0];res.json({data:row?view(row):null});
  });
  router.post('/me/email-change/:id/verify',async(req,res)=>{
    const requestId=parse(id,req.params.id),input=parse(z.object({oldCode:z.string().regex(/^\d{6}$/),newCode:z.string().regex(/^\d{6}$/)}).strict(),req.body);
    const outcome=await transaction(pool,async db=>{
      const user=await currentUser(db,req);
      const row=await requestRow(db,requestId,true);if(row.user_id!==user.id)notFound();
      if(row.attempts>=5)return{error:error(429,'EMAIL_CHANGE_ATTEMPTS_EXCEEDED','Đã quá số lần thử. Vui lòng yêu cầu hai mã mới.')};
      const invalid=await checkPending(db,row,'pending_verification');if(invalid)return{error:invalid};
      if(!row.delivery_confirmed)return{error:error(409,'EMAIL_CHANGE_NOT_READY','Chưa gửi xong cả hai mã xác thực.')};
      if(row.old_email!==user.email){await db.query("UPDATE email_change_requests SET status='invalidated' WHERE id=$1",[row.id]);return{error:error(409,'EMAIL_CHANGE_STALE','Email hiện tại đã thay đổi. Hãy tạo yêu cầu mới.')};}
      const context=`email-change:${row.id}:${row.old_email}:${row.new_email}`;
      const oldOK=constantEqual(row.old_code_hash,otpHash(config.otpSecret,`${context}:old`,input.oldCode));
      const newOK=constantEqual(row.new_code_hash,otpHash(config.otpSecret,`${context}:new`,input.newCode));
      if(!oldOK||!newOK){
        const attempts=row.attempts+1;await db.query('UPDATE email_change_requests SET attempts=$1,status=$2 WHERE id=$3',[attempts,attempts>=5?'invalidated':row.status,row.id]);
        return{error:error(attempts>=5?429:422,attempts>=5?'EMAIL_CHANGE_ATTEMPTS_EXCEEDED':'EMAIL_CHANGE_OTP_INVALID',attempts>=5?'Đã quá số lần thử. Hãy tạo yêu cầu mới.':'Hai mã xác thực chưa đúng. Vui lòng kiểm tra email cũ và mới.')};
      }
      await db.query("UPDATE email_change_requests SET status='pending_approval',verified_at=$1,expires_at=$2 WHERE id=$3",[now(),new Date(now().getTime()+86400000),row.id]);
      return{data:await detailed(db,row.id)};
    });
    if(outcome.error)throw outcome.error;res.json(outcome);
  });
  router.get('/email-change-requests',async(req,res)=>{admin(req.user);res.json({data:(await pool.query(`${requestSelect} WHERE e.status='pending_approval' AND e.expires_at>$1 ORDER BY e.created_at LIMIT 100`,[now()])).rows.map(view)});});
  router.post('/email-change-requests/:id/review',async(req,res)=>{
    admin(req.user);const requestId=parse(id,req.params.id),{decision}=parse(z.object({decision:z.enum(['approved','rejected'])}).strict(),req.body);
    const outcome=await transaction(pool,async db=>{
      // Same admin -> user -> request lock order as employee/admin mutations.
      await db.query("SELECT id FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL FOR UPDATE");
      const reviewer=await currentUser(db,req);
      if(!reviewer||reviewer.role!=='admin'||reviewer.status!=='active'||reviewer.deleted_at)fail(403,'FORBIDDEN','Tài khoản không còn quyền duyệt.');
      const lookup=await requestRow(db,requestId);if(lookup.user_id===reviewer.id)fail(403,'EMAIL_CHANGE_SELF_REVIEW','Cần một quản trị viên khác duyệt yêu cầu của bạn.');
      const user=(await db.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[lookup.user_id])).rows[0]??notFound();
      const row=await requestRow(db,requestId,true),invalid=await checkPending(db,row,'pending_approval');if(invalid)return{error:invalid};
      if(!row.delivery_confirmed||!row.verified_at||new Date(row.verified_at)>new Date(row.otp_expires_at))fail(409,'EMAIL_CHANGE_PROOF_REQUIRED','Yêu cầu chưa có đủ xác minh hợp lệ.');
      if(user.deleted_at||user.status==='suspended'||row.old_email!==user.email){await db.query("UPDATE email_change_requests SET status='invalidated' WHERE id=$1",[row.id]);return{error:error(409,'EMAIL_CHANGE_STALE','Tài khoản hoặc email hiện tại đã thay đổi.')};}
      if(decision==='approved'){
        if((await db.query('SELECT id FROM users WHERE email=$1',[row.new_email])).rows.length)return{error:error(409,'EMAIL_ALREADY_IN_USE','Email mới đã được một tài khoản khác sử dụng.')};
        await db.query('UPDATE users SET email=$1,email_verified=true,profile_version=profile_version+1 WHERE id=$2',[row.new_email,user.id]);
        await db.query('UPDATE sessions SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL',[now(),user.id]);
        await db.query('DELETE FROM notification_devices WHERE user_id=$1',[user.id]);
        await db.query('UPDATE otp_challenges SET consumed_at=$1 WHERE user_id=$2 AND consumed_at IS NULL',[now(),user.id]);
        await db.query('UPDATE fingerprint_devices SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL',[now(),user.id]);
        await db.query('UPDATE fingerprint_challenges SET consumed_at=$1 WHERE user_id=$2 AND consumed_at IS NULL',[now(),user.id]);
        await db.query("UPDATE email_change_requests SET status='invalidated' WHERE user_id=$1 AND id<>$2 AND status IN ('pending_verification','pending_approval')",[user.id,row.id]);
      }
      await db.query('UPDATE email_change_requests SET status=$1,reviewed_at=$2,reviewed_by=$3 WHERE id=$4',[decision,now(),reviewer.id,row.id]);
      return{data:await detailed(db,row.id)};
    });
    if(outcome.error)throw outcome.error;res.json(outcome);
  });
  return router;
}
