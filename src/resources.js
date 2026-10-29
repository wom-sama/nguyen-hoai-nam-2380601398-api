import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z, id, name, username, email, password, role, status, isoDate, coordinates, parse, routeId, nonemptyPatch } from './validation.js';
import { fail, hashPassword, publicUser, transaction } from './security.js';
import { loadFace } from './auth.js';
import { DEFAULT_TIME_POLICY, timePolicySchema, punchWindow, timingOf, createLocalClock } from './attendance-time.js';
import { criticalFactSchema, validateCriticalFacts, verifyFactAnswers } from './critical-facts.js';

const branchSchema = z.object({ name, address: z.string().trim().min(3).max(500), latitude: coordinates.latitude, longitude: coordinates.longitude, radiusMeters: z.number().finite().min(20).max(200000), timePolicy: timePolicySchema.optional() });
const shiftSchema = z.object({ title: name, branchId: id, employeeId: id, startsAt: isoDate, endsAt: isoDate, status: z.literal('scheduled').optional() });
const employeeSchema = z.object({ fullName: name, username, email, password, role: role.optional(), status: status.optional(), branchId: id.nullable().optional() });
const correctionSchema = z.object({ shiftId: id, requestedCheckIn: isoDate.nullable().optional(), requestedCheckOut: isoDate.nullable().optional(), reason: z.string().trim().min(5).max(2000) });
const itemSchema = z.object({ id, text: z.string().trim().min(1).max(1000), translatedText: z.string().max(2000), state: z.enum(['open','understood','clarify']).default('open') }).strict();
const handoverSchema = z.object({ shiftId: id, recipientId: id, originalText: z.string().trim().min(1).max(12000), translatedText: z.string().max(24000),
  sourceLanguage: z.enum(['vi','en','zh']), targetLanguage: z.enum(['vi','en','zh']), items: z.array(itemSchema).min(1).max(40),
  criticalFacts: z.array(criticalFactSchema).max(3).optional(), status: z.enum(['draft','submitted','acknowledged']).optional() });
const shiftSelect = 'SELECT s.*,u.full_name AS employee_name,b.name AS branch_name,a.id AS attendance_id,COALESCE(correction_stats.correction_count,0) AS correction_count FROM shifts s JOIN users u ON u.id=s.employee_id JOIN branches b ON b.id=s.branch_id LEFT JOIN attendance a ON a.shift_id=s.id AND a.employee_id=s.employee_id LEFT JOIN (SELECT shift_id,COUNT(*) AS correction_count FROM corrections GROUP BY shift_id) correction_stats ON correction_stats.shift_id=s.id';
const attendanceSelect = 'SELECT a.*,u.full_name AS employee_name,b.name AS branch_name,s.title AS shift_title,s.starts_at AS shift_starts_at,s.ends_at AS shift_ends_at,s.time_policy_snapshot FROM attendance a JOIN shifts s ON s.id=a.shift_id JOIN users u ON u.id=a.employee_id JOIN branches b ON b.id=s.branch_id';
const handoverFields = 'h.*,c.full_name AS created_by_name,r.full_name AS recipient_name,s.title AS shift_title,s.starts_at AS shift_starts_at';
const handoverFrom = ' FROM handovers h JOIN users c ON c.id=h.created_by JOIN users r ON r.id=h.recipient_id JOIN shifts s ON s.id=h.shift_id';
const columns = {
  fullName: 'full_name', username: 'username', email: 'email', role: 'role', status: 'status', branchId: 'branch_id',
  name: 'name', address: 'address', latitude: 'latitude', longitude: 'longitude', radiusMeters: 'radius_meters', timePolicy: 'time_policy',
  title: 'title', employeeId: 'employee_id', startsAt: 'starts_at', endsAt: 'ends_at', requestedCheckIn: 'requested_check_in', requestedCheckOut: 'requested_check_out', reason: 'reason',
  resolutionNote: 'resolution_note', recipientId: 'recipient_id', originalText: 'original_text', translatedText: 'translated_text', sourceLanguage: 'source_language', targetLanguage: 'target_language', items: 'items',
  criticalFacts: 'critical_facts', criticalFactConfirmation: 'critical_fact_confirmation',
};
export function serialize(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase()), value]));
}
const allowedBranch = (user, branchId) => user.role === 'admin' || (user.branch_id !== null && user.branch_id === branchId);
const manage = (user) => { if (!['admin','manager'].includes(user.role)) fail(403, 'FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này.'); };
const adminOnly = (user) => { if (user.role !== 'admin') fail(403, 'FORBIDDEN', 'Chỉ quản trị viên được thực hiện thao tác này.'); };
const notFound = () => fail(404, 'NOT_FOUND', 'Không tìm thấy dữ liệu trong phạm vi của bạn.');
async function updateRow(db, table, recordId, changes) {
  const entries = Object.entries(changes);
  if (!entries.length || entries.some(([key]) => !columns[key])) fail(422, 'EMPTY_UPDATE', 'Nội dung cập nhật không hợp lệ.');
  const values = entries.map(([key, value]) => ['items','timePolicy','criticalFacts','criticalFactConfirmation'].includes(key) && value !== null ? JSON.stringify(value) : value);
  const fields = entries.map(([key], index) => `${columns[key]}=$${index + 1}`).join(',');
  // table/column identifiers come exclusively from this module, never request data.
  const result = await db.query(`UPDATE ${table} SET ${fields} WHERE id=$${values.length + 1} RETURNING *`, [...values, recordId]);
  return result.rows[0];
}
async function find(db, table, recordId, locking = false) {
  const result = await db.query(`SELECT * FROM ${table} WHERE id=$1${locking ? ' FOR UPDATE' : ''}`, [recordId]);
  return result.rows[0] ?? notFound();
}
function checkTimes(start, end) {
  if (!start || !end || new Date(end) <= new Date(start)) fail(422, 'TIME_ORDER_INVALID', 'Thời gian kết thúc phải sau thời gian bắt đầu.');
}
export function distanceMeters(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = n => n * Math.PI / 180;
  const dLat = radians(latitudeB - latitudeA), dLon = radians(longitudeB - longitudeA);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function createResources({ pool, now, timeZone = 'Asia/Bangkok', enqueueNotification = async () => {} }) {
  const router = Router();
  const localClock = createLocalClock(timeZone);
  function shiftView(row) {
    const { attendance_id: attendanceId, correction_count: correctionCount, ...fields } = row;
    const hasAttendance = attendanceId != null, hasCorrections = Number(correctionCount ?? 0) > 0;
    return { ...serialize(fields), timeWindow: punchWindow(row), hasAttendance, hasCorrections,
      planLocked: hasAttendance || hasCorrections, planLockReason: hasAttendance ? 'attendance' : hasCorrections ? 'correction' : null };
  }
  function attendanceView(row) {
    const duty = { starts_at: row.shift_starts_at, ends_at: row.shift_ends_at, time_policy_snapshot: row.time_policy_snapshot };
    return { ...serialize(row), workDate: localClock.date(duty.starts_at), timeWindow: punchWindow(duty), timing: timingOf(duty, row, now()) };
  }
  async function attendanceRow(db, recordId) {
    return (await db.query(`${attendanceSelect} WHERE a.id=$1`, [recordId])).rows[0] ?? notFound();
  }
  async function visibleShift(db, recordId, user, forManagement = false, locking = false) {
    if (forManagement) manage(user);
    const shift = await find(db, 'shifts', recordId, locking);
    if (user.role === 'employee' ? shift.employee_id !== user.id : !allowedBranch(user, shift.branch_id)) notFound();
    return shift;
  }
  async function eligibleAssignment(db, employeeId, branchId) {
    const branch = await find(db, 'branches', branchId);
    const user = await find(db, 'users', employeeId);
    if (user.deleted_at || user.status !== 'active' || !user.email_verified || user.branch_id !== branchId) fail(422, 'EMPLOYEE_NOT_ELIGIBLE', 'Nhân viên phải được duyệt và thuộc chi nhánh của ca làm.');
    return branch;
  }
  async function employeeScope(db, actor) {
    if (actor.role === 'admin') return (await db.query('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500')).rows;
    if (actor.role === 'manager' && actor.branch_id) return (await db.query('SELECT * FROM users WHERE branch_id=$1 AND deleted_at IS NULL ORDER BY full_name LIMIT 500', [actor.branch_id])).rows;
    return [actor];
  }
  async function shiftsScope(db, actor) {
    if (actor.role === 'admin') return (await db.query(`${shiftSelect} ORDER BY s.starts_at DESC LIMIT 500`)).rows;
    if (actor.role === 'manager') return (await db.query(`${shiftSelect} WHERE s.branch_id=$1 ORDER BY s.starts_at DESC LIMIT 500`, [actor.branch_id])).rows;
    return (await db.query(`${shiftSelect} WHERE s.employee_id=$1 ORDER BY s.starts_at DESC LIMIT 500`, [actor.id])).rows;
  }
  async function attendanceScope(db, actor) {
    if (actor.role === 'admin') return (await db.query(`${attendanceSelect} ORDER BY a.check_in_at DESC LIMIT 500`)).rows;
    if (actor.role === 'manager') return (await db.query(`${attendanceSelect} WHERE s.branch_id=$1 ORDER BY a.check_in_at DESC LIMIT 500`, [actor.branch_id])).rows;
    return (await db.query(`${attendanceSelect} WHERE a.employee_id=$1 ORDER BY a.check_in_at DESC LIMIT 500`, [actor.id])).rows;
  }
  router.get('/employees', async (req, res) => res.json({ data: (await employeeScope(pool, req.user)).map(publicUser) }));
  router.get('/employees/:id', async (req, res) => {
    const employee = await find(pool, 'users', routeId(req));
    if (employee.deleted_at || (req.user.role === 'employee' ? employee.id !== req.user.id : !allowedBranch(req.user, employee.branch_id))) notFound();
    res.json({ data: publicUser(employee) });
  });
  router.post('/employees', async (req, res) => {
    adminOnly(req.user);
    const input = parse(employeeSchema.strict(), req.body);
    if (input.branchId) await find(pool, 'branches', input.branchId);
    const result = await pool.query('INSERT INTO users(id,full_name,username,email,password_hash,role,status,branch_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [randomUUID(), input.fullName, input.username, input.email, await hashPassword(input.password), input.role ?? 'employee', input.status ?? 'pending', input.branchId ?? null, now()]);
    res.status(201).json({ data: publicUser(result.rows[0]) });
  });
  async function guardLastAdmin(db, user, changes) {
    if (user.role !== 'admin' || user.status !== 'active' || user.deleted_at || (!changes.deleted && (changes.role ?? user.role) === 'admin' && (changes.status ?? user.status) === 'active')) return;
    await db.query("SELECT id FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL FOR UPDATE");
    const { rows } = await db.query("SELECT id FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL");
    if (rows.length <= 1) fail(409, 'LAST_ADMIN', 'Phải giữ lại ít nhất một quản trị viên đang hoạt động.');
  }
  router.patch('/employees/:id', async (req, res) => {
    adminOnly(req.user);
    const recordId = routeId(req), input = nonemptyPatch(employeeSchema, req.body);
    const result = await transaction(pool, async db => {
      // Lock all active admins first so concurrent changes cannot remove the last admin.
      await db.query("SELECT id FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL FOR UPDATE");
      const employee = await find(db, 'users', recordId, true);
      if (employee.deleted_at) notFound();
      await guardLastAdmin(db, employee, input);
      if (input.branchId) await find(db, 'branches', input.branchId);
      const { password: newPassword, ...fields } = input;
      const emailChanged = input.email !== undefined && input.email !== employee.email;
      const profileChanged = ['fullName','role','status','branchId'].some(key => Object.hasOwn(fields, key) && fields[key] !== employee[columns[key]]);
      let updated = Object.keys(fields).length ? await updateRow(db, 'users', recordId, fields) : employee;
      if (newPassword) updated = (await db.query('UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING *', [await hashPassword(newPassword), recordId])).rows[0];
      if (emailChanged) updated = (await db.query('UPDATE users SET email_verified=false WHERE id=$1 RETURNING *', [recordId])).rows[0];
      if (newPassword || emailChanged || input.status === 'suspended') {
        await db.query('UPDATE sessions SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL', [now(), recordId]);
        await db.query('DELETE FROM notification_devices WHERE user_id=$1', [recordId]);
        await db.query('UPDATE otp_challenges SET consumed_at=$1 WHERE user_id=$2 AND consumed_at IS NULL', [now(), recordId]);
      }
      if (profileChanged) {
        updated = (await db.query('UPDATE users SET profile_version=profile_version+1 WHERE id=$1 RETURNING *', [recordId])).rows[0];
        await enqueueNotification(db, { type: 'profile_updated', entityId: recordId, version: updated.profile_version, recipientId: recordId });
      }
      return updated;
    });
    res.json({ data: publicUser(result) });
  });
  router.delete('/employees/:id', async (req, res) => {
    adminOnly(req.user);
    const recordId = routeId(req);
    await transaction(pool, async db => {
      await db.query("SELECT id FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL FOR UPDATE");
      const employee = await find(db, 'users', recordId, true);
      if (employee.deleted_at) notFound();
      await guardLastAdmin(db, employee, { deleted: true });
      await db.query("UPDATE users SET deleted_at=$1,status='suspended',branch_id=NULL WHERE id=$2", [now(), recordId]);
      await db.query('UPDATE sessions SET revoked_at=$1 WHERE user_id=$2', [now(), recordId]);
      await db.query('DELETE FROM notification_devices WHERE user_id=$1', [recordId]);
      await db.query('DELETE FROM face_templates WHERE user_id=$1', [recordId]);
      await db.query('DELETE FROM location_shares WHERE user_id=$1', [recordId]);
    });
    res.json({ data: { deleted: true } });
  });
  router.get('/branches', async (req, res) => {
    const { rows } = req.user.role === 'admin' ? await pool.query('SELECT * FROM branches ORDER BY name LIMIT 500') : await pool.query('SELECT * FROM branches WHERE id=$1', [req.user.branch_id]);
    res.json({ data: rows.map(serialize) });
  });
  router.get('/branches/:id', async (req, res) => {
    const row = await find(pool, 'branches', routeId(req));
    if (!allowedBranch(req.user, row.id)) notFound();
    res.json({ data: serialize(row) });
  });
  router.post('/branches', async (req, res) => {
    adminOnly(req.user);
    const input = parse(branchSchema.strict(), req.body);
    const { rows } = await pool.query('INSERT INTO branches(id,name,address,latitude,longitude,radius_meters,time_policy,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [randomUUID(), input.name, input.address, input.latitude, input.longitude, input.radiusMeters, JSON.stringify(input.timePolicy ?? DEFAULT_TIME_POLICY), now()]);
    res.status(201).json({ data: serialize(rows[0]) });
  });
  router.patch('/branches/:id', async (req, res) => {
    adminOnly(req.user); const recordId = routeId(req), input = nonemptyPatch(branchSchema, req.body);
    await find(pool, 'branches', recordId);
    res.json({ data: serialize(await updateRow(pool, 'branches', recordId, input)) });
  });
  router.delete('/branches/:id', async (req, res) => {
    adminOnly(req.user); const recordId = routeId(req);
    await transaction(pool, async db => {
      await find(db, 'branches', recordId, true);
      const employees = await db.query('SELECT id FROM users WHERE branch_id=$1 LIMIT 1', [recordId]);
      const shifts = await db.query('SELECT id FROM shifts WHERE branch_id=$1 LIMIT 1', [recordId]);
      if (employees.rows.length || shifts.rows.length) fail(409, 'RECORD_IN_USE', 'Chi nhánh đang có nhân viên hoặc ca làm. Hãy xử lý các dữ liệu liên quan trước.');
      await db.query('DELETE FROM branches WHERE id=$1', [recordId]);
    }); res.json({ data: { deleted: true } });
  });
  router.get('/shifts', async (req, res) => res.json({ data: (await shiftsScope(pool, req.user)).map(shiftView) }));
  router.get('/shifts/:id', async (req, res) => {
    const { rows } = await pool.query(`${shiftSelect} WHERE s.id=$1`, [routeId(req)]);
    const row = rows[0] ?? notFound();
    if (req.user.role === 'employee' ? row.employee_id !== req.user.id : !allowedBranch(req.user, row.branch_id)) notFound();
    res.json({ data: shiftView(row) });
  });
  router.post('/shifts', async (req, res) => {
    manage(req.user);
    if (req.body?.status !== undefined && req.body.status !== 'scheduled') fail(422, 'SHIFT_STATUS_READ_ONLY', 'Ca mới bắt đầu ở trạng thái đã phân ca; trạng thái sau đó do hệ thống quản lý.');
    const input = parse(shiftSchema.strict(), req.body);
    if (!allowedBranch(req.user, input.branchId)) notFound(); checkTimes(input.startsAt, input.endsAt);
    const result = await transaction(pool, async db => {
      const branch = await eligibleAssignment(db, input.employeeId, input.branchId);
      const { rows } = await db.query("INSERT INTO shifts(id,title,branch_id,employee_id,starts_at,ends_at,status,time_policy_snapshot,created_at) VALUES($1,$2,$3,$4,$5,$6,'scheduled',$7,$8) RETURNING *",
        [randomUUID(), input.title, input.branchId, input.employeeId, input.startsAt, input.endsAt, JSON.stringify(branch.time_policy), now()]);
      await enqueueNotification(db, { type: 'shift_assigned', entityId: rows[0].id, version: rows[0].assignment_version, recipientId: input.employeeId });
      return rows[0];
    });
    res.status(201).json({ data: shiftView(result) });
  });
  router.patch('/shifts/:id', async (req, res) => {
    manage(req.user);
    if (Object.hasOwn(req.body ?? {}, 'status')) fail(422, 'SHIFT_STATUS_READ_ONLY', 'Trạng thái ca do hệ thống cập nhật từ chấm công và đơn điều chỉnh.');
    const recordId = routeId(req), input = nonemptyPatch(shiftSchema.omit({ status: true }), req.body);
    const result = await transaction(pool, async db => {
      const current = await visibleShift(db, recordId, req.user, true, true);
      if (!allowedBranch(req.user, input.branchId ?? current.branch_id)) notFound();
      checkTimes(input.startsAt ?? current.starts_at, input.endsAt ?? current.ends_at);
      const planChanged = (input.employeeId !== undefined && input.employeeId !== current.employee_id)
        || (input.branchId !== undefined && input.branchId !== current.branch_id)
        || (input.startsAt !== undefined && new Date(input.startsAt).getTime() !== new Date(current.starts_at).getTime())
        || (input.endsAt !== undefined && new Date(input.endsAt).getTime() !== new Date(current.ends_at).getTime());
      let branch;
      if (planChanged) {
        const recorded = await db.query('SELECT id FROM attendance WHERE shift_id=$1', [recordId]);
        const corrections = await db.query('SELECT id FROM corrections WHERE shift_id=$1 LIMIT 1', [recordId]);
        if (recorded.rows.length || corrections.rows.length) fail(409, 'SHIFT_PLAN_LOCKED', 'Ca đã có chấm công hoặc đơn điều chỉnh. Không được thay đổi nhân viên, chi nhánh hoặc giờ kế hoạch của lịch sử này.');
        branch = await eligibleAssignment(db, input.employeeId ?? current.employee_id, input.branchId ?? current.branch_id);
      }
      await updateRow(db, 'shifts', recordId, input);
      if (planChanged) await db.query('UPDATE shifts SET time_policy_snapshot=$1 WHERE id=$2', [JSON.stringify(branch.time_policy), recordId]);
      if (input.employeeId !== undefined && input.employeeId !== current.employee_id) {
        const reassigned = (await db.query('UPDATE shifts SET assignment_version=assignment_version+1 WHERE id=$1 RETURNING *', [recordId])).rows[0];
        await enqueueNotification(db, { type: 'shift_assigned', entityId: recordId, version: reassigned.assignment_version, recipientId: reassigned.employee_id });
      }
      return (await db.query(`${shiftSelect} WHERE s.id=$1`, [recordId])).rows[0];
    }); res.json({ data: shiftView(result) });
  });
  router.delete('/shifts/:id', async (req, res) => {
    const recordId = routeId(req);
    await transaction(pool, async db => {
      await visibleShift(db, recordId, req.user, true, true);
      for (const table of ['attendance','corrections','handovers']) {
        const related = await db.query(`SELECT id FROM ${table} WHERE shift_id=$1 LIMIT 1`, [recordId]);
        if (related.rows.length) fail(409, 'RECORD_IN_USE', 'Ca đã có chấm công, đơn điều chỉnh hoặc bàn giao nên được giữ lại để đối soát.');
      }
      await db.query('DELETE FROM shifts WHERE id=$1', [recordId]);
    }); res.json({ data: { deleted: true } });
  });
  router.get('/attendance', async (req, res) => res.json({ data: (await attendanceScope(pool, req.user)).map(attendanceView) }));
  for (const action of ['check-in','check-out']) router.post(`/attendance/${action}`, async (req, res) => {
    const input = parse(z.object({ shiftId: id, ...coordinates }).strict(), req.body);
    const result = await transaction(pool, async db => {
      const duty = await find(db, 'shifts', input.shiftId, true);
      if (duty.employee_id !== req.user.id) notFound();
      const branch = await find(db, 'branches', duty.branch_id);
      const distance = distanceMeters(input.latitude, input.longitude, branch.latitude, branch.longitude);
      if (distance + input.accuracyMeters > branch.radius_meters) fail(422, 'OUTSIDE_GEOFENCE', 'Bạn đang ngoài phạm vi chấm công hoặc vị trí chưa đủ chính xác.');
      const previous = (await db.query('SELECT * FROM attendance WHERE employee_id=$1 AND shift_id=$2 FOR UPDATE', [req.user.id, duty.id])).rows[0];
      const time = now(), window = punchWindow(duty);
      if (action === 'check-in') {
        if (previous) fail(409, 'ALREADY_CHECKED_IN', 'Ca làm này đã được ghi nhận giờ vào.');
        if (time < new Date(window.checkInOpensAt) || time > new Date(window.checkInClosesAt)) fail(409, 'PUNCH_WINDOW_CLOSED', 'Chưa đến khung giờ chấm công vào hoặc ca đã kết thúc. Nếu thiếu giờ vào, hãy gửi đơn điều chỉnh công.');
        const inserted = await db.query('INSERT INTO attendance(id,employee_id,shift_id,check_in_at,recorded_check_in_at,latitude,longitude,accuracy_meters) VALUES($1,$2,$3,$4,$4,$5,$6,$7) RETURNING *',
          [randomUUID(), req.user.id, duty.id, time, input.latitude, input.longitude, input.accuracyMeters]);
        await db.query("UPDATE shifts SET status='in_progress' WHERE id=$1", [duty.id]); return attendanceRow(db, inserted.rows[0].id);
      }
      if (!previous || previous.check_out_at) fail(409, 'CHECK_OUT_INVALID', previous ? 'Ca làm này đã được ghi nhận giờ ra.' : 'Bạn cần chấm công vào trước khi chấm công ra.');
      if (time > new Date(window.checkOutClosesAt)) fail(409, 'PUNCH_WINDOW_CLOSED', 'Đã hết khung giờ chấm công ra của ca này. Hãy gửi đơn điều chỉnh để quản lý kiểm tra.');
      if (time < new Date(previous.check_in_at) || (previous.recorded_check_in_at && time < new Date(previous.recorded_check_in_at))) fail(409, 'CHECK_OUT_INVALID', 'Giờ hiện tại đang trước giờ vào đã ghi nhận. Hãy kiểm tra hoặc gửi đơn điều chỉnh.');
      const updated = await db.query('UPDATE attendance SET check_out_at=$1,recorded_check_out_at=$1 WHERE id=$2 RETURNING *', [time, previous.id]);
      await db.query("UPDATE shifts SET status='completed' WHERE id=$1", [duty.id]); return attendanceRow(db, updated.rows[0].id);
    }); res.status(action === 'check-in' ? 201 : 200).json({ data: attendanceView(result) });
  });
  router.get('/corrections', async (req, res) => {
    let result;
    if (req.user.role === 'admin') result = await pool.query('SELECT * FROM corrections ORDER BY created_at DESC LIMIT 500');
    else if (req.user.role === 'manager') result = await pool.query('SELECT c.* FROM corrections c JOIN shifts s ON s.id=c.shift_id WHERE s.branch_id=$1 ORDER BY c.created_at DESC LIMIT 500', [req.user.branch_id]);
    else result = await pool.query('SELECT * FROM corrections WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 500', [req.user.id]);
    res.json({ data: result.rows.map(serialize) });
  });
  async function visibleCorrection(db, recordId, actor, locking = false) {
    const correction = await find(db, 'corrections', recordId, locking);
    await visibleShift(db, correction.shift_id, actor);
    if (actor.role === 'employee' && correction.employee_id !== actor.id) notFound(); return correction;
  }
  router.get('/corrections/:id', async (req, res) => res.json({ data: serialize(await visibleCorrection(pool, routeId(req), req.user)) }));
  function correctionTimes(input) {
    if (!input.requestedCheckIn && !input.requestedCheckOut) fail(422, 'CORRECTION_TIME_REQUIRED', 'Cần nhập giờ vào hoặc giờ ra muốn điều chỉnh.');
    if (input.requestedCheckIn && input.requestedCheckOut && new Date(input.requestedCheckOut) < new Date(input.requestedCheckIn)) fail(422, 'TIME_ORDER_INVALID', 'Giờ ra phải bằng hoặc sau giờ vào.');
  }
  router.post('/corrections', async (req, res) => {
    const input = parse(correctionSchema.strict(), req.body); correctionTimes(input);
    const result = await transaction(pool, async db => {
      const duty = await visibleShift(db, input.shiftId, req.user, false, true);
      if (duty.employee_id !== req.user.id) fail(403, 'FORBIDDEN', 'Bạn chỉ được gửi đơn điều chỉnh công của mình.');
      const { rows } = await db.query('INSERT INTO corrections(id,employee_id,shift_id,requested_check_in,requested_check_out,reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *',
        [randomUUID(), req.user.id, duty.id, input.requestedCheckIn ?? null, input.requestedCheckOut ?? null, input.reason, now()]);
      return rows[0];
    }); res.status(201).json({ data: serialize(result) });
  });
  router.patch('/corrections/:id', async (req, res) => {
    const recordId = routeId(req);
    const input = parse(z.object({ reason: correctionSchema.shape.reason.optional(), requestedCheckIn: isoDate.nullable().optional(), requestedCheckOut: isoDate.nullable().optional(), status: z.enum(['pending','approved','rejected']).optional(), resolutionNote: z.string().trim().max(2000).optional() }).strict(), req.body);
    if (!Object.keys(input).length) fail(422, 'EMPTY_UPDATE', 'Chưa có nội dung cần cập nhật.');
    const result = await transaction(pool, async db => {
      const current = await visibleCorrection(db, recordId, req.user, true);
      if (current.status !== 'pending') fail(409, 'CORRECTION_RESOLVED', 'Đơn đã xử lý không thể chỉnh sửa.');
      if (current.employee_id === req.user.id) {
        if ((input.status && input.status !== 'pending') || input.resolutionNote !== undefined) fail(403, 'SELF_APPROVAL_FORBIDDEN', 'Không được tự duyệt đơn điều chỉnh công của mình.');
        correctionTimes({ requestedCheckIn: input.requestedCheckIn === undefined ? current.requested_check_in : input.requestedCheckIn, requestedCheckOut: input.requestedCheckOut === undefined ? current.requested_check_out : input.requestedCheckOut });
        const updated = await updateRow(db, 'corrections', recordId, input);
        return (await db.query('UPDATE corrections SET updated_at=$1 WHERE id=$2 RETURNING *', [now(), updated.id])).rows[0];
      }
      manage(req.user);
      if (!['approved','rejected'].includes(input.status) || Object.keys(input).some(x => !['status','resolutionNote'].includes(x))) fail(403, 'FORBIDDEN', 'Người duyệt chỉ được nhập kết quả xử lý và ghi chú.');
      await find(db, 'shifts', current.shift_id, true);
      const existing = (await db.query('SELECT * FROM attendance WHERE employee_id=$1 AND shift_id=$2 FOR UPDATE', [current.employee_id, current.shift_id])).rows[0];
      const beforeSnapshot = existing ? JSON.stringify(serialize(existing)) : null;
      let after = existing;
      if (input.status === 'approved') {
        const checkIn = current.requested_check_in ?? existing?.check_in_at;
        const checkOut = current.requested_check_out ?? existing?.check_out_at ?? null;
        if (!checkIn || (checkOut && new Date(checkOut) < new Date(checkIn))) fail(422, 'TIME_ORDER_INVALID', 'Giờ chấm công sau điều chỉnh không hợp lệ.');
        if (existing) after = (await db.query("UPDATE attendance SET check_in_at=$1,check_out_at=$2,source='correction' WHERE id=$3 RETURNING *", [checkIn, checkOut, existing.id])).rows[0];
        else after = (await db.query("INSERT INTO attendance(id,employee_id,shift_id,check_in_at,check_out_at,source) VALUES($1,$2,$3,$4,$5,'correction') RETURNING *", [randomUUID(), current.employee_id, current.shift_id, checkIn, checkOut])).rows[0];
        await db.query('UPDATE shifts SET status=$1 WHERE id=$2', [checkOut ? 'completed' : 'in_progress', current.shift_id]);
      }
      const afterSnapshot = after ? JSON.stringify(serialize(after)) : null;
      const updated = await db.query('UPDATE corrections SET status=$1,resolution_note=$2,resolved_by=$3,updated_at=$4,resolved_at=$4,before_attendance=$5,after_attendance=$6 WHERE id=$7 RETURNING *', [input.status, input.resolutionNote ?? '', req.user.id, now(), beforeSnapshot, afterSnapshot, recordId]);
      await enqueueNotification(db, { type: 'correction_reviewed', entityId: recordId, recipientId: current.employee_id });
      return updated.rows[0];
    }); res.json({ data: serialize(result) });
  });
  router.delete('/corrections/:id', async (req, res) => {
    const recordId = routeId(req);
    await transaction(pool, async db => {
      const current = await visibleCorrection(db, recordId, req.user, true);
      if (current.employee_id !== req.user.id) fail(403, 'FORBIDDEN', 'Chỉ người gửi được rút đơn của mình.');
      if (current.status !== 'pending') fail(409, 'CORRECTION_RESOLVED', 'Đơn đã xử lý không thể xóa.');
      await db.query('DELETE FROM corrections WHERE id=$1', [recordId]);
    }); res.json({ data: { deleted: true } });
  });
  router.post('/location-shares', async (req, res) => {
    const input = parse(z.object({ ...coordinates, ttlMinutes: z.number().int().min(1).max(120) }).strict(), req.body);
    if (!req.user.branch_id) fail(422, 'BRANCH_REQUIRED', 'Cần được phân chi nhánh trước khi chia sẻ vị trí.');
    const result = await pool.query('INSERT INTO location_shares(id,user_id,latitude,longitude,accuracy_meters,expires_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,accuracy_meters=EXCLUDED.accuracy_meters,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at RETURNING *',
      [randomUUID(), req.user.id, input.latitude, input.longitude, input.accuracyMeters, new Date(now().getTime() + input.ttlMinutes * 60000), now()]);
    res.status(201).json({ data: serialize(result.rows[0]) });
  });
  router.get('/location-shares', async (req, res) => {
    let result;
    if (req.user.role === 'admin') result = await pool.query('SELECT l.*,u.full_name FROM location_shares l JOIN users u ON u.id=l.user_id WHERE l.expires_at>$1 AND u.deleted_at IS NULL LIMIT 500', [now()]);
    else if (req.user.role === 'manager') result = await pool.query('SELECT l.*,u.full_name FROM location_shares l JOIN users u ON u.id=l.user_id WHERE l.expires_at>$1 AND u.branch_id=$2 AND u.deleted_at IS NULL LIMIT 500', [now(), req.user.branch_id]);
    else result = await pool.query('SELECT l.*,u.full_name FROM location_shares l JOIN users u ON u.id=l.user_id WHERE l.expires_at>$1 AND l.user_id=$2 LIMIT 1', [now(), req.user.id]);
    res.json({ data: result.rows.map(serialize) });
  });
  router.delete('/location-shares/:id', async (req, res) => {
    const result = await pool.query('DELETE FROM location_shares WHERE id=$1 AND user_id=$2 RETURNING id', [routeId(req), req.user.id]);
    if (!result.rows.length) notFound(); res.json({ data: { deleted: true } });
  });
  router.get('/handover-recipients', async (req, res) => {
    const { rows } = await pool.query("SELECT id,full_name,role,branch_id FROM users WHERE branch_id=$1 AND id<>$2 AND status='active' AND email_verified=true AND deleted_at IS NULL ORDER BY full_name LIMIT 500", [req.user.branch_id, req.user.id]);
    res.json({ data: rows.map(serialize) });
  });
  async function visibleHandover(db, recordId, actor, locking = false) {
    const row = await find(db, 'handovers', recordId, locking);
    if (row.created_by !== actor.id && row.recipient_id !== actor.id) {
      if (actor.role === 'employee') notFound(); await visibleShift(db, row.shift_id, actor);
    } return row;
  }
  async function eligibleRecipient(db, recipientId, branchId, senderId) {
    if (recipientId === senderId) fail(422, 'RECIPIENT_INVALID', 'Người nhận phải khác người bàn giao.');
    const user = await find(db, 'users', recipientId);
    if (user.deleted_at || user.status !== 'active' || !user.email_verified || user.branch_id !== branchId) fail(422, 'RECIPIENT_INVALID', 'Người nhận phải đang hoạt động và cùng chi nhánh.');
  }
  function checkItems(items) {
    if (new Set(items.map(x => x.id)).size !== items.length) fail(422, 'ITEM_DUPLICATE', 'Mỗi mục bàn giao cần mã riêng.');
  }
  async function revision(db, row, actorId) {
    await db.query('INSERT INTO handover_revisions(id,handover_id,actor_id,version,snapshot,created_at) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), row.id, actorId, row.version, JSON.stringify(serialize(row)), now()]);
  }
  router.get('/handovers', async (req, res) => {
    let result;
    if (req.user.role === 'admin') result = await pool.query(`SELECT ${handoverFields}${handoverFrom} ORDER BY h.updated_at DESC LIMIT 500`);
    else if (req.user.role === 'manager') result = await pool.query(`SELECT ${handoverFields}${handoverFrom} WHERE s.branch_id=$1 ORDER BY h.updated_at DESC LIMIT 500`, [req.user.branch_id]);
    else result = await pool.query(`SELECT ${handoverFields}${handoverFrom} WHERE h.created_by=$1 OR h.recipient_id=$1 ORDER BY h.updated_at DESC LIMIT 500`, [req.user.id]);
    res.json({ data: result.rows.map(serialize) });
  });
  router.get('/handovers/:id', async (req, res) => {
    const { rows } = await pool.query(`SELECT ${handoverFields},s.branch_id AS scope_branch_id${handoverFrom} WHERE h.id=$1`, [routeId(req)]);
    const { scope_branch_id: scopeBranchId, ...row } = rows[0] ?? notFound();
    if (row.created_by !== req.user.id && row.recipient_id !== req.user.id && (req.user.role === 'employee' || !allowedBranch(req.user, scopeBranchId))) notFound();
    res.json({ data: serialize(row) });
  });
  router.get('/handovers/:id/revisions', async (req, res) => {
    const recordId = routeId(req); await visibleHandover(pool, recordId, req.user);
    const { rows } = await pool.query('SELECT * FROM handover_revisions WHERE handover_id=$1 ORDER BY version', [recordId]);
    res.json({ data: rows.map(serialize) });
  });
  router.post('/handovers', async (req, res) => {
    const input = parse(handoverSchema.strict(), req.body); checkItems(input.items);
    if (input.status === 'acknowledged' || input.items.some(x => x.state !== 'open')) fail(403, 'RECIPIENT_CONFIRMATION_REQUIRED', 'Người nhận sẽ tự xác nhận các mục đã hiểu.');
    const submitted = input.status === 'submitted';
    const criticalFacts = validateCriticalFacts(input.criticalFacts ?? [], { originalText: input.originalText, translatedText: input.translatedText, required: submitted, requireAnchors: submitted });
    const result = await transaction(pool, async db => {
      const duty = await visibleShift(db, input.shiftId, req.user);
      if (duty.employee_id !== req.user.id) fail(403, 'FORBIDDEN', 'Bạn chỉ được tạo bàn giao gắn với ca của mình.');
      await eligibleRecipient(db, input.recipientId, duty.branch_id, req.user.id);
      const inserted = await db.query('INSERT INTO handovers(id,shift_id,created_by,recipient_id,original_text,translated_text,source_language,target_language,items,status,critical_facts,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *',
        [randomUUID(), input.shiftId, req.user.id, input.recipientId, input.originalText, input.translatedText, input.sourceLanguage, input.targetLanguage, JSON.stringify(input.items), input.status ?? 'draft', JSON.stringify(criticalFacts), now()]);
      await revision(db, inserted.rows[0], req.user.id);
      if (inserted.rows[0].status === 'submitted') await enqueueNotification(db, { type: 'handover_submitted', entityId: inserted.rows[0].id, version: inserted.rows[0].version, recipientId: inserted.rows[0].recipient_id });
      return inserted.rows[0];
    }); res.status(201).json({ data: serialize(result) });
  });
  router.patch('/handovers/:id', async (req, res) => {
    const recordId = routeId(req);
    const input = parse(handoverSchema.omit({ shiftId: true }).partial().extend({ version: z.number().int().positive(), factAnswers: z.unknown().optional() }).strict(), req.body);
    if (Object.keys(input).length < 2) fail(422, 'EMPTY_UPDATE', 'Chưa có nội dung cần cập nhật.');
    const result = await transaction(pool, async db => {
      const current = await visibleHandover(db, recordId, req.user, true);
      if (input.version !== current.version) fail(409, 'VERSION_CONFLICT', 'Bàn giao đã thay đổi. Hãy tải lại trước khi xác nhận.');
      if (current.status === 'acknowledged' && current.created_by !== req.user.id) fail(409, 'HANDOVER_ACKNOWLEDGED', 'Bàn giao đã xác nhận chỉ có thể được người gửi sửa và yêu cầu xác nhận lại.');
      const { version: expectedVersion, ...changes } = input;
      let fields;
      if (current.created_by === req.user.id) {
        if (Object.hasOwn(changes, 'factAnswers') || changes.status === 'acknowledged' || changes.items?.some(x => x.state !== 'open')) fail(403, 'RECIPIENT_CONFIRMATION_REQUIRED', 'Không được xác nhận hoặc nhập câu trả lời thay người nhận.');
        if (current.status !== 'draft' && changes.status === 'draft') fail(409, 'HANDOVER_ACTIVE_NO_DRAFT', 'Bàn giao đã gửi phải được sửa thành bản gửi mới, không chuyển về nháp để bỏ bước kiểm tra.');
        const duty = await find(db, 'shifts', current.shift_id);
        if (changes.recipientId) await eligibleRecipient(db, changes.recipientId, duty.branch_id, req.user.id);
        if (changes.items) checkItems(changes.items);
        const finalStatus = current.status === 'draft' ? (changes.status ?? 'draft') : 'submitted';
        const criticalFacts = validateCriticalFacts(changes.criticalFacts ?? current.critical_facts ?? [], {
          originalText: changes.originalText ?? current.original_text, translatedText: changes.translatedText ?? current.translated_text,
          required: finalStatus === 'submitted', requireAnchors: finalStatus === 'submitted' });
        // Every author amendment invalidates recipient evidence. Old proof remains
        // in the immutable revision snapshot; the amended active row is resubmitted.
        fields = { ...changes, status: finalStatus, criticalFacts, criticalFactConfirmation: null,
          items: (changes.items ?? current.items).map(x => ({ ...x, state: 'open' })) };
      } else if (current.recipient_id === req.user.id) {
        if (current.status !== 'submitted' || Object.keys(changes).some(x => !['items','status','factAnswers'].includes(x))) fail(403, 'FORBIDDEN', 'Người nhận chỉ được xác nhận các mục và nhập lại thông tin của bàn giao đã gửi.');
        const requestedItems = changes.items ?? current.items;
        checkItems(requestedItems);
        if (requestedItems.length !== current.items.length) fail(422, 'ITEM_CONTENT_CHANGED', 'Người nhận không được sửa nội dung bàn giao.');
        const states = new Map();
        for (const item of requestedItems) {
          const original = current.items.find(x => x.id === item.id);
          if (!original || original.text !== item.text || original.translatedText !== item.translatedText) fail(422, 'ITEM_CONTENT_CHANGED', 'Người nhận không được sửa nội dung bàn giao.');
          states.set(item.id, item.state);
        }
        const items = current.items.map(x => ({ ...x, state: states.get(x.id) }));
        const finalStatus = changes.status ?? 'submitted';
        if (!['submitted','acknowledged'].includes(finalStatus) || (finalStatus === 'acknowledged' && items.some(x => x.state !== 'understood'))) fail(422, 'UNDERSTANDING_REQUIRED', 'Cần xác nhận đã hiểu tất cả mục trước khi hoàn tất.');
        if (Object.hasOwn(changes, 'factAnswers') && finalStatus !== 'acknowledged') fail(422, 'FACT_ANSWERS_FINAL_ONLY', 'Chỉ gửi câu trả lời khi xác nhận hoàn tất bàn giao.');
        let confirmation = null;
        if (finalStatus === 'acknowledged') {
          const criticalFacts = validateCriticalFacts(current.critical_facts ?? [], { originalText: current.original_text, translatedText: current.translated_text, required: true, requireAnchors: true });
          const answers = verifyFactAnswers(criticalFacts, changes.factAnswers);
          confirmation = { verifiedBy: req.user.id, verifiedAt: now().toISOString(), version: expectedVersion + 1, answers };
        }
        fields = { items, status: finalStatus, criticalFactConfirmation: confirmation };
      } else fail(403, 'FORBIDDEN', 'Chỉ người bàn giao hoặc người nhận được thay đổi phiếu.');
      await updateRow(db, 'handovers', recordId, fields);
      const changed = await db.query('UPDATE handovers SET version=version+1,updated_at=$1 WHERE id=$2 AND version=$3 RETURNING *', [now(), recordId, expectedVersion]);
      if (!changed.rows[0]) fail(409, 'VERSION_CONFLICT', 'Bàn giao đã thay đổi. Hãy tải lại.');
      await revision(db, changed.rows[0], req.user.id);
      if (current.created_by === req.user.id && changed.rows[0].status === 'submitted') await enqueueNotification(db, { type: 'handover_submitted', entityId: recordId, version: changed.rows[0].version, recipientId: changed.rows[0].recipient_id });
      return changed.rows[0];
    }); res.json({ data: serialize(result) });
  });
  router.delete('/handovers/:id', async (req, res) => {
    const recordId = routeId(req);
    await transaction(pool, async db => {
      const current = await visibleHandover(db, recordId, req.user, true);
      if (current.created_by !== req.user.id) fail(403, 'FORBIDDEN', 'Chỉ người tạo được xóa bản nháp.');
      if (current.status !== 'draft') fail(409, 'HANDOVER_SUBMITTED', 'Bàn giao đã gửi được giữ lại để đối soát.');
      await db.query('DELETE FROM handover_revisions WHERE handover_id=$1', [recordId]);
      await db.query('DELETE FROM handovers WHERE id=$1', [recordId]);
    }); res.json({ data: { deleted: true } });
  });
  router.get('/reports/monthly', async (req, res) => {
    const filters = parse(z.object({ month: z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/), employeeId: id.optional(), branchId: id.optional() }).strict(), req.query);
    let employeeId = filters.employeeId, branchId = filters.branchId;
    if (req.user.role === 'employee') {
      if ((employeeId && employeeId !== req.user.id) || (branchId && branchId !== req.user.branch_id)) fail(403, 'REPORT_SCOPE_FORBIDDEN', 'Bạn chỉ được xem bảng công của mình.');
      employeeId = req.user.id;
    } else if (req.user.role === 'manager') {
      if (branchId && branchId !== req.user.branch_id) fail(403, 'REPORT_SCOPE_FORBIDDEN', 'Bạn chỉ được xem bảng công của chi nhánh được phân quản lý.');
      branchId = req.user.branch_id;
      if (employeeId) {
        const target = (await pool.query('SELECT branch_id FROM users WHERE id=$1', [employeeId])).rows[0];
        if (!target || target.branch_id !== branchId) fail(403, 'REPORT_SCOPE_FORBIDDEN', 'Nhân viên được chọn nằm ngoài phạm vi quản lý.');
      }
    }
    const monthStart = new Date(`${filters.month}-01T00:00:00.000Z`), monthEnd = new Date(monthStart);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
    // A one-day margin includes every current IANA offset. Filter by the actual local
    // starting date below; do not split an overnight shift by its checkout month.
    const values = [new Date(monthStart.getTime() - 86400000), new Date(monthEnd.getTime() + 86400000)];
    const conditions = ['s.starts_at >= $1', 's.starts_at < $2'];
    if (employeeId !== undefined) { values.push(employeeId); conditions.push(`s.employee_id=$${values.length}`); }
    if (branchId !== undefined) { values.push(branchId); conditions.push(`s.branch_id=$${values.length}`); }
    const selected = await pool.query(`SELECT s.*,u.full_name AS employee_name,b.name AS branch_name,a.id AS attendance_id,a.check_in_at,a.check_out_at,a.recorded_check_in_at,a.recorded_check_out_at,a.source FROM shifts s JOIN users u ON u.id=s.employee_id JOIN branches b ON b.id=s.branch_id LEFT JOIN attendance a ON a.shift_id=s.id AND a.employee_id=s.employee_id WHERE ${conditions.join(' AND ')} ORDER BY s.starts_at,u.full_name LIMIT 5001`, values);
    if (selected.rows.length > 5000) fail(422, 'REPORT_TOO_LARGE', 'Báo cáo có quá nhiều ca. Hãy lọc theo chi nhánh hoặc nhân viên.');
    const time = now();
    const rows = selected.rows.filter(row => localClock.date(row.starts_at).startsWith(filters.month)).map(row => ({
      shiftId: row.id, title: row.title, employeeId: row.employee_id, employeeName: row.employee_name, branchId: row.branch_id, branchName: row.branch_name,
      workDate: localClock.date(row.starts_at), startsAt: row.starts_at, endsAt: row.ends_at, status: row.status,
      timePolicySnapshot: row.time_policy_snapshot, timeWindow: punchWindow(row), attendanceId: row.attendance_id ?? null,
      checkInAt: row.check_in_at ?? null, checkOutAt: row.check_out_at ?? null,
      recordedCheckInAt: row.recorded_check_in_at ?? null, recordedCheckOutAt: row.recorded_check_out_at ?? null, source: row.source ?? null,
      timing: timingOf(row, row.attendance_id ? row : null, time),
      localTimes: { startsAt: localClock.timestamp(row.starts_at), endsAt: localClock.timestamp(row.ends_at),
        checkInAt: localClock.timestamp(row.check_in_at), checkOutAt: localClock.timestamp(row.check_out_at),
        recordedCheckInAt: localClock.timestamp(row.recorded_check_in_at), recordedCheckOutAt: localClock.timestamp(row.recorded_check_out_at) },
    }));
    const count = state => rows.filter(row => row.timing.state === state).length;
    res.json({ data: { month: filters.month, timeZone, rows, totals: {
      shiftCount: rows.length, completedCount: count('completed'), inProgressCount: count('in_progress'), upcomingCount: count('upcoming'),
      notCheckedInCount: count('not_checked_in'), missingCheckInCount: count('missing_check_in'), missingCheckOutCount: count('missing_check_out'),
      lateCount: rows.filter(row => row.timing.late).length, earlyLeaveCount: rows.filter(row => row.timing.earlyLeave).length,
      rawSpanMinutes: rows.reduce((sum, row) => sum + (row.timing.rawSpanMinutes ?? 0), 0),
      recordedSpanMinutes: rows.reduce((sum, row) => sum + (row.timing.recordedSpanMinutes ?? 0), 0),
    } } });
  });
  router.get('/face/status', async (req, res) => {
    const { rows } = await pool.query('SELECT enrolled_at FROM face_templates WHERE user_id=$1', [req.user.id]);
    res.json({ data: { enrolled: Boolean(rows.length), enrolledAt: rows[0]?.enrolled_at ?? null } });
  });
  router.post('/face/enroll', async (req, res) => {
    const input = parse(z.object({ imageBase64: z.string().min(16).max(2800000) }).strict(), req.body);
    const recognition = await loadFace();
    const embedding = await recognition.extractEmbedding(input.imageBase64);
    const result = await pool.query('INSERT INTO face_templates(user_id,embedding,enrolled_at) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET embedding=EXCLUDED.embedding,enrolled_at=EXCLUDED.enrolled_at RETURNING enrolled_at', [req.user.id, JSON.stringify(embedding), now()]);
    res.status(201).json({ data: { enrolled: true, enrolledAt: result.rows[0].enrolled_at } });
  });
  router.delete('/face/enroll', async (req, res) => {
    await pool.query('DELETE FROM face_templates WHERE user_id=$1', [req.user.id]);
    res.json({ data: { enrolled: false, enrolledAt: null } });
  });
  router.get('/dashboard', async (req, res) => {
    const [employees, shifts, attendance] = await Promise.all([employeeScope(pool, req.user), shiftsScope(pool, req.user), attendanceScope(pool, req.user)]);
    const today = localClock.date(now());
    res.json({ data: { employeeCount: employees.length, pendingEmployeeCount: employees.filter(x => x.status === 'pending').length,
      shiftCount: shifts.length, checkedInCount: attendance.filter(x => localClock.date(x.check_in_at) === today && !x.check_out_at).length,
      shifts: shifts.slice(0, 20).map(shiftView), attendance: attendance.slice(0, 20).map(attendanceView) } });
  });
  return router;
}
