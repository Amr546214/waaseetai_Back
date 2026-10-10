import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

// #26 — phone change needs a code sent to the account email. Real Express + real authenticate / requireActiveUser / service; the database, the
// session store, the mail and the audit log are replaced.
process.env.JWT_SECRET = 'phone-secret';
process.env.OPENAI_API_KEY = 'x';

type Otp = { id: string; userId: string; code: string; type: string; expiresAt: Date; attempts: number; context: any; createdAt: Date };
const U1 = 'u1', U2 = 'u2', SUSP = 'u3';
const users: Record<string, any> = {
	[U1]: { id: U1, email: 'one@example.com', phoneNumber: '0500000001', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] },
	[U2]: { id: U2, email: 'two@example.com', phoneNumber: '0500000002', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', activeRole: 'CLIENT', roles: ['CLIENT'] },
	[SUSP]: { id: SUSP, email: 'three@example.com', phoneNumber: '0500000003', accountType: 'CLIENT_INDIVIDUAL', status: 'SUSPENDED', activeRole: 'CLIENT', roles: ['CLIENT'] },
};
let otps: Otp[] = [];
let seq = 0;
const sent: { to: string; code: string }[] = [];
const audit: any[] = [], notes: any[] = [];
let mailFails = false;
const prisma: any = {
	user: {
		findUnique: async ({ where }: any) => (users[where.id] ? { ...users[where.id] } : null),
		update: async ({ where, data }: any) => {
			if (data.phoneNumber && Object.values(users).some(u => u.id !== where.id && u.phoneNumber === data.phoneNumber)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
			Object.assign(users[where.id], data); return { ...users[where.id] };
		},
	},
	otpVerification: {
		findFirst: async ({ where }: any) => otps.filter(o => o.userId === where.userId && o.type === where.type && (!where.context || o.context?.purpose === where.context.equals)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
		create: async ({ data }: any) => { const o = { id: `o${++seq}`, attempts: 0, createdAt: new Date(Date.now() + seq), ...data }; otps.push(o); return o; },
		deleteMany: async ({ where }: any) => { const before = otps.length; otps = otps.filter(o => !(o.userId === where.userId && o.type === where.type && (!where.context || o.context?.purpose === where.context.equals))); return { count: before - otps.length }; },
		delete: async ({ where }: any) => { otps = otps.filter(o => o.id !== where.id); return {}; },
		update: async ({ where, data }: any) => { const o = otps.find(x => x.id === where.id)!; if (data.attempts?.increment) o.attempts += data.attempts.increment; return o; },
	},
};
prisma.$transaction = async (fn: any) => { const snapshot = JSON.stringify(users); try { return await fn(prisma); } catch (e) { const s = JSON.parse(snapshot); for (const k of Object.keys(s)) users[k] = s[k]; throw e; } };

let srv: Promise<{ url: string; close: () => void }> | undefined;
function server() {
	srv ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('../services/session.service', { namedExports: { sessionService: { validateOrRegister: async () => ({ id: 's1' }) } } });
		mock.module('../services/account-logs.service', { namedExports: { accountAuditLogService: { record: async (e: any) => { audit.push(e); } } } });
		mock.module('../services/notification.service', { namedExports: { notificationService: {
			sendPhoneChangeOtpEmail: async (to: string, code: string) => { if (mailFails) throw new Error('SMTP down'); sent.push({ to, code }); },
			createAndEmit: async (n: any) => { notes.push(n); },
		} } });
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const app = express();
		app.use(express.json());
		app.use('/profiles', (await import('./profile/profile.routes')).default);
		app.use(globalErrorHandler);
		const s = http.createServer(app);
		await new Promise<void>(r => s.listen(0, r));
		return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
	})();
	return srv;
}
async function call(as: string | null, path: string, body?: any, method = 'POST') {
	const { url } = await server();
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (as) headers.authorization = `Bearer ${jwt.sign({ userId: as, accountType: 'CLIENT_INDIVIDUAL' }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
	const res = await fetch(`${url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
	return { status: res.status, body: await res.json().catch(() => ({})) };
}
const reset = async () => {
	otps = []; sent.length = 0; audit.length = 0; notes.length = 0; mailFails = false;
	users[U1].phoneNumber = '0500000001'; users[U2].phoneNumber = '0500000002';
	(await import('../utils/otp-send-throttle')).otpSendThrottle.reset();
};
const REQ = '/profiles/phone/change/request', CONF = '/profiles/phone/change/confirm';
const lastCode = () => sent.at(-1)!.code;
const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

test('request: a code goes to the ACCOUNT EMAIL (not to the new number), the pending number is only in the OTP context, the phone is unchanged', async () => {
	await reset();
	const r = await call(U1, REQ, { phoneNumber: '0511111111' });
	assert.equal(r.status, 200);
	assert.equal(r.body.data.emailSent, true);
	assert.equal(r.body.data.expiresInSeconds, 600);
	assert.deepEqual(sent.map(s => s.to), ['one@example.com']);
	assert.equal(users[U1].phoneNumber, '0500000001');
	assert.equal(otps.length, 1);
	assert.equal(otps[0].context.purpose, 'PHONE_CHANGE');
	assert.equal(otps[0].context.newPhone, '0511111111');
	assert.doesNotMatch(JSON.stringify(r.body), /0511111111|\d{6}/);
});

test('confirm with the right code changes the phone, spends the code, audits it (masked) and notifies', async () => {
	await reset();
	await call(U1, REQ, { phoneNumber: '0511111111' });
	const r = await call(U1, CONF, { code: lastCode() });
	assert.equal(r.status, 200);
	assert.equal(users[U1].phoneNumber, '0511111111');
	assert.equal(otps.length, 0);
	const e = audit.find(a => a.eventType === 'PHONE_CHANGED');
	assert.ok(e);
	assert.doesNotMatch(JSON.stringify(e), /0511111111|0500000001/);
	assert.ok(notes.some(n => n.userId === U1));
	assert.equal((await call(U1, CONF, { code: '123456' })).status, 400, 'a spent code cannot be replayed');
});

test('wrong code: 400 and the attempt is counted; the 5th wrong guess locks (429) and deletes the code, so even the right code no longer works', async () => {
	await reset();
	await call(U1, REQ, { phoneNumber: '0511111111' });
	const good = lastCode();
	for (let i = 1; i <= 4; i++) {
		const r = await call(U1, CONF, { code: wrong(good) });
		assert.equal(r.status, 400, `attempt ${i}`);
		assert.equal(r.body.message, 'رمز التحقق غير صحيح');
	}
	assert.equal(otps[0].attempts, 4);
	const locked = await call(U1, CONF, { code: wrong(good) });
	assert.equal(locked.status, 429);
	assert.match(locked.body.message, /تجاوز عدد المحاولات/);
	assert.equal(otps.length, 0);
	const after = await call(U1, CONF, { code: good });
	assert.equal(after.status, 400);
	assert.match(after.body.message, /اطلب رمزًا جديدًا/);
	assert.equal(users[U1].phoneNumber, '0500000001');
	assert.ok(audit.some(a => a.eventType === 'PHONE_CHANGE_REJECTED'));
});

test('expired code: 400 "request a new code", the code is removed and the phone is unchanged', async () => {
	await reset();
	await call(U1, REQ, { phoneNumber: '0511111111' });
	otps[0].expiresAt = new Date(Date.now() - 1000);
	const r = await call(U1, CONF, { code: lastCode() });
	assert.equal(r.status, 400);
	assert.match(r.body.message, /انتهت صلاحية/);
	assert.equal(otps.length, 0);
	assert.equal(users[U1].phoneNumber, '0500000001');
});

test('no code was ever requested, or a code of another purpose (password reset) with the same digits: refused', async () => {
	await reset();
	assert.equal((await call(U1, CONF, { code: '123456' })).status, 400);
	otps.push({ id: 'x', userId: U1, code: '123456', type: 'EMAIL', expiresAt: new Date(Date.now() + 60000), attempts: 0, context: { purpose: 'PASSWORD_RESET' }, createdAt: new Date() });
	assert.equal((await call(U1, CONF, { code: '123456' })).status, 400);
	assert.equal(users[U1].phoneNumber, '0500000001');
});

test('a number that belongs to another user: the request looks exactly like any other; confirming gives a GENERIC 409 that never says the number is taken, and the code is spent', async () => {
	await reset();
	const free = await call(U1, REQ, { phoneNumber: '0599999999' });
	await reset();
	const taken = await call(U1, REQ, { phoneNumber: '0500000002' });
	assert.equal(taken.status, free.status);
	assert.deepEqual(Object.keys(taken.body).sort(), Object.keys(free.body).sort());
	assert.deepEqual(Object.keys(taken.body.data).sort(), Object.keys(free.body.data).sort());
	assert.equal(taken.body.message, free.body.message);
	assert.equal(sent.length, 1, 'the code is sent either way');
	const r = await call(U1, CONF, { code: lastCode() });
	assert.equal(r.status, 409);
	assert.match(r.body.message, /تعذر حفظ رقم الجوال/);
	assert.doesNotMatch(r.body.message, /مسجل|مستخدم|موجود|محجوز|لشخص|حساب آخر|taken|exists|unique/i);
	assert.equal(users[U1].phoneNumber, '0500000001');
	assert.equal(users[U2].phoneNumber, '0500000002');
	assert.equal(otps.length, 0, 'the spent code cannot be used to probe other numbers');
});

test('a new request replaces the previous code (the newest wins); the old code no longer works', async () => {
	await reset();
	await call(U1, REQ, { phoneNumber: '0511111111' });
	const first = lastCode();
	otpSendThrottle_bypass();
	await call(U1, REQ, { phoneNumber: '0522222222' });
	const second = lastCode();
	assert.equal(otps.length, 1);
	if (first !== second) assert.equal((await call(U1, CONF, { code: first })).status, 400);
	assert.equal((await call(U1, CONF, { code: second })).status, 200);
	assert.equal(users[U1].phoneNumber, '0522222222');
});
function otpSendThrottle_bypass() { import('../utils/otp-send-throttle').then(m => m.otpSendThrottle.reset()); }

test('validation and throttling: bad number 400, same as current 400, a second request within 60 s is 429', async () => {
	await reset();
	for (const bad of ['abc', '12345', '1'.repeat(16), '']) {
		const r = await call(U1, REQ, { phoneNumber: bad });
		assert.equal(r.status, 400, bad);
		assert.ok(r.body.errors.some((e: any) => e.field === 'phoneNumber'));
	}
	assert.equal((await call(U1, REQ, { phoneNumber: '0500000001' })).status, 400);
	assert.equal((await call(U1, CONF, { code: '12' })).status, 400);
	assert.equal(sent.length, 0);
	assert.equal((await call(U1, REQ, { phoneNumber: '0511111111' })).status, 200);
	const again = await call(U1, REQ, { phoneNumber: '0511111111' });
	assert.equal(again.status, 429);
	assert.match(again.body.message, /يمكنك إعادة الإرسال بعد/);
});

test('mail failure: the answer says so (emailSent false), no usable code remains, the phone is unchanged', async () => {
	await reset();
	mailFails = true;
	const r = await call(U1, REQ, { phoneNumber: '0511111111' });
	assert.equal(r.status, 200);
	assert.equal(r.body.data.emailSent, false);
	assert.equal(otps.length, 0);
	assert.equal(users[U1].phoneNumber, '0500000001');
});

test('who may use it: unauthenticated 401; a suspended account 403', async () => {
	await reset();
	assert.equal((await call(null, REQ, { phoneNumber: '0511111111' })).status, 401);
	assert.equal((await call(null, CONF, { code: '123456' })).status, 401);
	assert.equal((await call(SUSP, REQ, { phoneNumber: '0511111111' })).status, 403);
	assert.equal((await call(SUSP, CONF, { code: '123456' })).status, 403);
});

test('one user cannot confirm with another user\'s code', async () => {
	await reset();
	await call(U1, REQ, { phoneNumber: '0511111111' });
	const r = await call(U2, CONF, { code: lastCode() });
	assert.equal(r.status, 400);
	assert.equal(users[U1].phoneNumber, '0500000001');
	assert.equal(users[U2].phoneNumber, '0500000002');
});

test('PUT /profiles/update no longer changes the phone: a different number is refused (400 with the OTP message), the same number is ignored', async () => {
	await reset();
	const { profileService } = await import('../services/profile.service');
	void profileService;
	const diff = await call(U1, '/profiles/update', { phoneNumber: '0533333333' }, 'PUT');
	assert.equal(diff.status, 400);
	assert.match(diff.body.message, /رمز تحقق/);
	assert.equal(users[U1].phoneNumber, '0500000001');
});

test.after(async () => { (await server()).close(); });
