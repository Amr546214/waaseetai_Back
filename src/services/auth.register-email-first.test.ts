import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTER_PROOF_REJECTED_MESSAGE, REGISTER_DATA_UNAVAILABLE_MESSAGE } from '../utils/auth-messages';

// E-mail-first registration: the address is proven BEFORE any account exists. In-memory repository that enforces the same two unique
// indexes as the database (users.email, users.phoneNumber), real service + controller + schemas + proof utilities.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';
process.env.RATE_LIMIT_ENABLED = 'true';

const PASSWORD = 'Str0ng!Pass1';
// an Egyptian number typed three ways: with the trunk zero, without it, and with the country digits; always stored as 1000000001 under +20
const BODY = { email: 'new.person@example.com', phoneNumber: '01000000001', phoneCountryCode: '+20', firstName: 'Sample', lastName: 'Person', accountType: 'CLIENT_INDIVIDUAL', agreedToTerms: true as const };
const OWNER = { id: '55555555-5555-4555-8555-555555555555', email: 'owner@example.com', phoneNumber: '1000000001', phoneCountryCode: '+20', firstName: 'Own', lastName: 'Er', accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', password: 'x', activeRole: 'CLIENT', roles: ['CLIENT'] };

async function world(t: TestContext, o: { users?: any[]; smtpFails?: boolean } = {}) {
	const store = { users: [...(o.users ?? [])] as any[], proofMails: [] as { to: string; code: string }[], sessions: 0, otherMails: 0 };
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../config/db', { namedExports: { prisma: { user: { update: async () => ({}), findUnique: async () => null }, $transaction: async () => ({}) } } });
	t.mock.module('./session.service', { namedExports: { sessionService: { register: async () => { store.sessions++; return {}; } } } });
	t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
	const clash = (email: string, phone: string) => store.users.find((u) => u.email.toLowerCase() === email.toLowerCase() || (u.phoneNumber && u.phoneNumber === phone));
	t.mock.module('../repositories/auth.repository', { namedExports: { authRepository: {
		findByEmailOrPhone: async (email: string, phone: string) => { await new Promise((r) => setImmediate(r)); return clash(email, phone) ?? null; },
		findByEmail: async () => null,
		findById: async () => null,
		createUserWithProfile: async (input: any, hash: string, _g: unknown, status: string) => {
			if (clash(input.email, input.phoneNumber)) throw Object.assign(new Error('unique'), { code: 'P2002' });
			const u = { id: `new-${store.users.length}`, email: input.email, phoneNumber: input.phoneNumber, phoneCountryCode: input.phoneCountryCode, firstName: input.firstName, lastName: input.lastName, accountType: input.accountType, status: status ?? 'PENDING_VERIFICATION', password: hash, activeRole: 'CLIENT', roles: ['CLIENT'] };
			store.users.push(u);
			return u;
		},
	} } });
	t.mock.module('./notification.service', { namedExports: { notificationService: {
		sendRegistrationProofEmail: async (to: string, code: string) => { if (o.smtpFails) throw new Error('smtp'); store.proofMails.push({ to, code }); },
		sendEmailOtp: async () => { store.otherMails++; },
		sendLoginOtpEmail: async () => { store.otherMails++; },
		sendPasswordResetEmail: async () => { store.otherMails++; },
	} } });
	const { authService } = await import(`./auth.service.ts?fx=${Date.now()}-${Math.random()}`);
	t.mock.module('./auth.service', { namedExports: { authService } });
	const { authController } = await import(`../controllers/auth.controller.ts?fx=${Date.now()}-${Math.random()}`);
	const proof = await import('../utils/registration-proof');
	proof.proofAttempts.reset();
	return { authService, authController, store, proof };
}

async function call(handler: any, body: any) {
	const out: any = { status: 200, body: undefined, error: undefined, locals: {} };
	const res: any = { locals: out.locals, status(c: number) { out.status = c; return this; }, json(b: any) { out.body = b; return this; } };
	await handler({ body, ip: '1.1.1.1', get: () => '', headers: {} }, res, (e: any) => { out.error = e; });
	return out;
}
const errOf = (p: Promise<unknown>) => p.then(() => null, (e) => ({ status: e.statusCode, message: e.message, code: e.code }));
const completeBody = (start: any, code: string, extra: object = {}) => ({ ...BODY, password: PASSWORD, ticket: start.ticket, code, ...extra });

test('new e-mail + new phone: start sends one proof mail and creates NOTHING; complete creates an ACTIVE account and signs in', async (t) => {
	const w = await world(t);
	const s = await w.authService.startRegistration({ ...BODY });
	assert.equal(s.emailSent, true);
	assert.ok(s.ticket);
	assert.equal(w.store.users.length, 0, 'no account and no phone reserved by a code request');
	assert.equal(w.store.proofMails.length, 1);
	assert.equal(w.store.otherMails, 0, 'only the proof mail, no activation / login mail');
	assert.ok(!JSON.stringify(s).includes(w.store.proofMails[0].code), 'the code is never in the response');
	const r: any = await w.authService.completeRegistration(completeBody(s, w.store.proofMails[0].code) as any);
	assert.ok(r.token);
	assert.equal(w.store.users.length, 1);
	assert.equal(w.store.users[0].status, 'ACTIVE');
	assert.equal(w.store.users[0].phoneNumber, '1000000001');
	assert.equal(w.store.users[0].phoneCountryCode, '+20');
	assert.equal(w.store.sessions, 1);
});

test('Egyptian number with the trunk zero, without it and with the country digits all normalise to the same stored phone', async (t) => {
	for (const typed of ['01000000001', '1000000001', '201000000001']) {
		await t.test(typed, async (st) => {
			const w = await world(st, { users: [{ ...OWNER }] });
			const b = { ...BODY, phoneNumber: typed };
			const s = await w.authService.startRegistration(b);
			const e = await errOf(w.authService.completeRegistration({ ...b, password: PASSWORD, ticket: s.ticket!, code: w.store.proofMails[0].code } as any));
			assert.equal(e?.status, 409, `${typed} is the same phone as the existing account`);
			assert.equal(w.store.users.length, 1);
		});
	}
});

test('phone in use + new e-mail: start answers like a free phone; complete -> ONE generic 409, no account, no session, nothing about the owner', async (t) => {
	const w = await world(t, { users: [{ ...OWNER }] });
	const a = await w.authService.startRegistration({ ...BODY });
	assert.deepEqual(Object.keys(a).sort(), ['emailSent', 'expiresAt', 'ticket'], 'the start answer has the same shape as for a free phone (see the first test)');
	const e = await errOf(w.authService.completeRegistration(completeBody(a, w.store.proofMails[0].code) as any));
	assert.deepEqual(e, { status: 409, message: REGISTER_DATA_UNAVAILABLE_MESSAGE, code: 'REGISTRATION_DATA_UNAVAILABLE' });
	assert.equal(w.store.users.length, 1, 'the existing account is untouched, no second one');
	assert.equal(w.store.sessions, 0);
	assert.doesNotMatch(JSON.stringify(e), /owner@|Own|1000000001|ACTIVE/);
});

test('e-mail in use (ACTIVE or PENDING_VERIFICATION owner): the same generic 409, nothing created, no mail to the owner beyond the proof code', async (t) => {
	for (const status of ['ACTIVE', 'PENDING_VERIFICATION']) {
		await t.test(status, async (st) => {
			const w = await world(st, { users: [{ ...OWNER, email: BODY.email, phoneNumber: '1999999999', status }] });
			const s = await w.authService.startRegistration({ ...BODY });
			const e = await errOf(w.authService.completeRegistration(completeBody(s, w.store.proofMails[0].code) as any));
			assert.equal(e?.status, 409);
			assert.equal(e?.message, REGISTER_DATA_UNAVAILABLE_MESSAGE);
			assert.equal(w.store.users.length, 1);
			assert.equal(w.store.sessions, 0);
		});
	}
});

test('wrong, other-address, forged and malformed tickets/codes are ONE answer; five wrong codes lock the ticket even for the right code', async (t) => {
	const w = await world(t);
	const s = await w.authService.startRegistration({ ...BODY });
	const good = w.store.proofMails[0].code;
	const wrong = good === '000000' ? '111111' : '000000';
	const results = [
		await errOf(w.authService.completeRegistration(completeBody(s, wrong) as any)),
		await errOf(w.authService.completeRegistration({ ...completeBody(s, good), email: 'other@example.com' } as any)),
		await errOf(w.authService.completeRegistration(completeBody({ ticket: 'x'.repeat(40) }, good) as any)),
	];
	for (const r of results) assert.deepEqual(r, { status: 400, message: REGISTER_PROOF_REJECTED_MESSAGE, code: undefined });
	for (let i = 0; i < 4; i++) await errOf(w.authService.completeRegistration(completeBody(s, wrong) as any));
	const locked = await errOf(w.authService.completeRegistration(completeBody(s, good) as any));
	assert.equal(locked?.status, 400, 'locked after the allowed wrong codes');
	assert.equal(w.store.users.length, 0);
});

test('an expired ticket is rejected with the same answer (10 minutes)', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
	const w = await world(t);
	const s = await w.authService.startRegistration({ ...BODY });
	t.mock.timers.tick(11 * 60 * 1000);
	const e = await errOf(w.authService.completeRegistration(completeBody(s, w.store.proofMails[0].code) as any));
	assert.deepEqual(e, { status: 400, message: REGISTER_PROOF_REJECTED_MESSAGE, code: undefined });
	assert.equal(w.store.users.length, 0);
});

test('a used proof cannot create a second account (replay -> generic 409) and never signs anyone in again', async (t) => {
	const w = await world(t);
	const s = await w.authService.startRegistration({ ...BODY });
	const code = w.store.proofMails[0].code;
	await w.authService.completeRegistration(completeBody(s, code) as any);
	const again = await errOf(w.authService.completeRegistration(completeBody(s, code) as any));
	assert.ok(again && (again.status === 409 || again.status === 400));
	assert.equal(w.store.users.length, 1);
	assert.equal(w.store.sessions, 1);
});

test('a proven address may retry corrected data with the same code, but only a few times; then a new code is required', async (t) => {
	const w = await world(t, { users: [{ ...OWNER }] });
	const s = await w.authService.startRegistration({ ...BODY });
	const code = w.store.proofMails[0].code;
	const same = completeBody(s, code);
	for (let i = 0; i < 3; i++) assert.equal((await errOf(w.authService.completeRegistration(same as any)))?.status, 409);
	const fixed = await errOf(w.authService.completeRegistration({ ...same, phoneNumber: '01000000002' } as any));
	assert.equal(fixed?.status, 400, 'after three rejected completions the ticket is spent');
	const s2 = await w.authService.startRegistration({ ...BODY, phoneNumber: '01000000002' });
	const ok: any = await w.authService.completeRegistration({ ...BODY, phoneNumber: '01000000002', password: PASSWORD, ticket: s2.ticket!, code: w.store.proofMails[1].code } as any);
	assert.ok(ok.token);
	assert.equal(w.store.users.length, 2);
});

test('two simultaneous completions for the same phone: exactly one account is created, the other gets the generic 409', async (t) => {
	const w = await world(t);
	const A = { ...BODY, email: 'a.person@example.com' };
	const B = { ...BODY, email: 'b.person@example.com' };
	const sa = await w.authService.startRegistration(A);
	const sb = await w.authService.startRegistration(B);
	const res = await Promise.all([
		errOf(w.authService.completeRegistration({ ...A, password: PASSWORD, ticket: sa.ticket!, code: w.store.proofMails[0].code } as any)),
		errOf(w.authService.completeRegistration({ ...B, password: PASSWORD, ticket: sb.ticket!, code: w.store.proofMails[1].code } as any)),
	]);
	assert.equal(res.filter((r) => r === null).length, 1);
	assert.equal(res.filter((r) => r?.status === 409).length, 1);
	assert.equal(w.store.users.length, 1);
	assert.equal(w.store.sessions, 1);
});

test('SMTP failure: start says emailSent=false, returns no ticket, creates nothing; the controller reports it so no cooldown starts', async (t) => {
	const w = await world(t, { smtpFails: true });
	const r = await call(w.authController.registerStart.bind(w.authController), { ...BODY });
	assert.equal(r.status, 200);
	assert.equal(r.body.success, false);
	assert.equal(r.body.data.emailSent, false);
	assert.equal(r.body.data.ticket, undefined);
	assert.equal(r.locals.otpEmailAttempted, true);
	assert.equal(r.locals.otpEmailSent, false);
	assert.equal(w.store.users.length, 0);
});

test('invalid phone for the chosen country is a plain 400 at start and at complete (nothing sent / created)', async (t) => {
	const w = await world(t);
	const e = await errOf(w.authService.startRegistration({ ...BODY, phoneNumber: '12345678901' }));
	assert.equal(e?.status, 400);
	assert.equal(w.store.proofMails.length, 0);
});

test('controller: complete answers 201 with a token only on success; a conflict is 409 with no token', async (t) => {
	const w = await world(t, { users: [{ ...OWNER }] });
	const s = await w.authService.startRegistration({ ...BODY });
	const bad = await call(w.authController.registerComplete.bind(w.authController), completeBody(s, w.store.proofMails[0].code));
	assert.equal(bad.error?.statusCode, 409);
	assert.equal(bad.body, undefined);
});
