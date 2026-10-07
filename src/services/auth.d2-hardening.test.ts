import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import { registerSchema, loginSchema, forgotPasswordSchema, verifyResetCodeSchema, resetPasswordSchema } from '../routes/auth/auth.schema';
import { normalizeOtpIdentifier } from '../middlewares/rate-limit.middleware';
import { generateReferralSlug, isReferralSlugConflict } from '../utils/slug.util';

// PR-D2: #22 email normalisation, #37 similar timing, #41/#55 referral slug + atomic profile.
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';

const REG = { accountType: 'CLIENT_INDIVIDUAL', firstName: 'Test', lastName: 'User', phoneNumber: '500000001', password: 'Password1', agreedToTerms: true };

test('#22 every auth schema trims and lower-cases the email', () => {
	const e = '  Amr.Okasha@Example.COM ';
	const want = 'amr.okasha@example.com';
	assert.equal((registerSchema.parse({ body: { ...REG, email: e } }) as any).body.email, want);
	assert.equal(loginSchema.parse({ body: { email: e, password: 'x' } }).body.email, want);
	assert.equal(forgotPasswordSchema.parse({ body: { email: e } }).body.email, want);
	assert.equal(verifyResetCodeSchema.parse({ body: { email: e, code: '123456' } }).body.email, want);
	assert.equal(resetPasswordSchema.parse({ body: { email: e, code: '123456', newPassword: 'Password1' } }).body.email, want);
	assert.equal(loginSchema.safeParse({ body: { email: 'not-an-email', password: 'x' } }).success, false);
});

test('#22 the OTP / limiter bucket key is the same for every spelling of one address', () => {
	assert.equal(normalizeOtpIdentifier('  A@B.com '), normalizeOtpIdentifier('a@b.COM'));
});

test('#22 lookup by email: exact normalised match first, then a case-insensitive fallback for legacy mixed-case accounts', async (t) => {
	const calls: any[] = [];
	const legacy = { id: 'legacy', email: 'Legacy@Example.com' };
	t.mock.module('../config/db', { namedExports: { prisma: { user: {
		findUnique: async (a: any) => { calls.push(['unique', a.where.email]); return a.where.email === 'new@example.com' ? { id: 'new' } : null; },
		findFirst: async (a: any) => { calls.push(['first', a.where]); const eq = a.where.email; return eq?.mode === 'insensitive' && eq.equals.toLowerCase() === legacy.email.toLowerCase() ? legacy : null; }
	} } } });
	const { authRepository } = await import(`../repositories/auth.repository.ts?fx=${Math.random()}`);
	assert.equal((await authRepository.findByEmail('  NEW@Example.com'))?.id, 'new');
	assert.equal((await authRepository.findByEmail('legacy@example.com'))?.id, 'legacy', 'legacy mixed-case account is not locked out');
	assert.equal(await authRepository.findByEmail('nobody@example.com'), null);
	assert.deepEqual(calls[0], ['unique', 'new@example.com']);
	await authRepository.findByEmailOrPhone('X@Y.com', '500');
	const dup = calls.at(-1);
	assert.equal(dup[1].OR[0].email.mode, 'insensitive');
});

const cfg: { over: any } = { over: {} };
const mockedFor = new WeakSet<object>();
function mocks(t: TestContext, over: any = {}) {
	cfg.over = over;
	if (mockedFor.has(t)) return;
	mockedFor.add(t);
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	t.mock.module('../config/db', { namedExports: { prisma: {} } });
	t.mock.module('./session.service', { namedExports: { sessionService: { register: async () => ({}) } } });
	t.mock.module('./account-logs.service', { namedExports: { accountAuditLogService: { record: async () => ({}) } } });
	t.mock.module('../repositories/auth.repository', { namedExports: { authRepository: {
		findByEmail: async () => cfg.over.user ?? null, findLatestPasswordResetOtp: async () => null, deletePasswordResetOtps: async () => ({}), createPasswordResetOtp: async () => ({})
	} } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { sendPasswordResetEmail: (...a: any[]) => (cfg.over.send ?? (async () => {}))(...a), sendEmailOtp: async () => {} } } });
}

test('#37 login with an UNKNOWN email still performs a bcrypt compare (same cost as a wrong password) and answers the same 401', async (t) => {
	mocks(t);
	const compare = t.mock.method(bcrypt, 'compare', async () => false);
	const { authService } = await import(`./auth.service.ts?fx=${Math.random()}`);
	await assert.rejects(() => authService.loginUser({ email: 'ghost@example.com', password: 'Whatever1' }), (e: any) => e.statusCode === 401 && /غير صحيحة/.test(e.message));
	assert.equal(compare.mock.callCount(), 1);
	assert.match(String(compare.mock.calls[0].arguments[1]), /^\$2[aby]\$12\$/, 'compared against a cost-12 dummy hash');
});

test('#37 forgot-password does not wait for the mail server: a hanging SMTP call does not delay the (generic) answer, a failing one is swallowed', async (t) => {
	mocks(t, { user: { id: 'u1', email: 'a@b.com', firstName: 'A' }, send: () => new Promise(() => {}) });
	const { authService } = await import(`./auth.service.ts?fx=${Math.random()}`);
	const started = Date.now();
	const res = await Promise.race([authService.forgotPassword({ email: 'a@b.com' }), new Promise(r => setTimeout(() => r('TIMEOUT'), 2000))]);
	assert.notEqual(res, 'TIMEOUT');
	assert.ok(Date.now() - started < 1500);
	assert.match((res as any).message, /إذا كان البريد/);
	cfg.over = { user: { id: 'u1', email: 'a@b.com', firstName: 'A' }, send: async () => { throw new Error('SMTP down'); } };
	assert.match((await authService.forgotPassword({ email: 'a@b.com' })).message, /إذا كان البريد/);
	await new Promise(r => setTimeout(r, 20)); // the swallowed rejection must not surface as an unhandled rejection
});

test('#41/#55 Arabic names no longer collapse to "user"+4 chars: slugs are random, well-formed and effectively unique', () => {
	const slugs = new Set<string>();
	for (let i = 0; i < 2000; i++) slugs.add(generateReferralSlug('خالد العتيبي', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
	assert.equal(slugs.size, 2000, 'no collision in 2k Arabic-name slugs (the old scheme had only 65k values for ALL Arabic names)');
	for (const s of [...slugs].slice(0, 50)) assert.match(s, /^user[a-z0-9]{6}$/);
	assert.match(generateReferralSlug('Khalid Alotaibi', 'x'), /^khalidalotaibi[a-z0-9]{6}$/);
	assert.ok(generateReferralSlug('a'.repeat(80), 'x').length <= 26);
});

test('#41 isReferralSlugConflict recognises P2002 on referralSlug (and an adapter P2002 without target) but not other errors', () => {
	assert.equal(isReferralSlugConflict({ code: 'P2002', meta: { target: ['referralSlug'] } }), true);
	assert.equal(isReferralSlugConflict({ code: 'P2002', meta: { target: 'affiliate_profiles_referralSlug_key' } }), true);
	assert.equal(isReferralSlugConflict({ code: 'P2002', meta: {} }), true);
	assert.equal(isReferralSlugConflict({ code: 'P2002', meta: { target: ['email'] } }), false);
	assert.equal(isReferralSlugConflict(new Error('x')), false);
});

test('#41/#55 registration: a referralSlug collision rolls the whole transaction back and is retried with a new slug — the user is never left without the affiliate profile', async (t) => {
	const committed: any[] = [];
	const committedProfile: string[] = [];
	let txAttempts = 0;
	t.mock.module('../config/db', { namedExports: { prisma: {
		$transaction: async (fn: any) => {
			txAttempts++;
			const staged: any[] = [];
			const tx: any = { user: { create: async (a: any) => { staged.push(['user', a.data.email]); return { id: 'u1', ...a.data, idNumber: null, idExpiryDate: null, ibanNumber: null, bankName: null, accountHolderName: null, idDocumentUrl: null }; } } };
			const out = await fn(tx);
			committed.push(...staged); // reached only when the callback did not throw (= commit)
			return out;
		}
	} } });
	t.mock.module('./account-management.service', { namedExports: {
		getRoleFromAccountType: () => 'AFFILIATE', getInitialRolesForAccountType: () => ['AFFILIATE'],
		createMissingRoleProfiles: async () => { if (txAttempts === 1) throw Object.assign(new Error('dup'), { code: 'P2002', meta: { target: ['referralSlug'] } }); committedProfile.push('u1'); }
	} });
	const { authRepository } = await import(`../repositories/auth.repository.ts?fx=${Math.random()}`);
	const user = await authRepository.createUserWithProfile({ accountType: 'MARKETING_BROKER', firstName: 'خالد', lastName: 'س', email: 'k@x.com', phoneNumber: '500000009', phoneCountryCode: '+966', agreedToTerms: true } as any, 'hash');
	assert.equal(user.id, 'u1');
	assert.equal(txAttempts, 2, 'retried once');
	assert.deepEqual(committedProfile, ['u1'], 'the profile exists for the user that was committed');
	assert.equal(committed.filter(c => c[0] === 'user').length, 1, 'exactly one user row committed (the failed attempt rolled back)');
});

test('#41 a non-slug error is not retried', async (t) => {
	let n = 0;
	t.mock.module('../config/db', { namedExports: { prisma: { $transaction: async () => { n++; throw Object.assign(new Error('email dup'), { code: 'P2002', meta: { target: ['email'] } }); } } } });
	const { authRepository } = await import(`../repositories/auth.repository.ts?fx=${Math.random()}`);
	await assert.rejects(() => authRepository.createUserWithProfile({ accountType: 'CLIENT_INDIVIDUAL' } as any, 'h'));
	assert.equal(n, 1);
});
