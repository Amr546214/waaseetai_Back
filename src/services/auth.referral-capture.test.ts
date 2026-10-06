import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerSchema } from '../routes/auth/auth.schema';

// AUD-FND-000060 — registration referral capture. Proves which inputs used to drop the referral silently (the user is
// created either way) and that they are now attributed, while a wrong / inactive / unknown code still never blocks signup.
// POST /api/auth/register -> registerSchema (strips unknown keys) -> authService.registerUser -> resolveReferralAttribution
// -> prisma.referral.create; GET /api/marketer-overview/referrals reads prisma.referral by the marketer's own affiliateId.

type Affiliate = { id: string; userId: string; referralSlug: string; status?: string };
const state: { affiliates: Affiliate[]; referrals: any[]; createError: any } = { affiliates: [], referrals: [], createError: null };
const logs: string[] = [];

// One module-level mock per module (cached imports keep the first mock), driven through `state`.
const findFirst = async (args: any) => {
	const [bySlug, byId] = args.where.OR;
	const slugCond = bySlug.referralSlug;
	const slugMatches = (a: Affiliate) =>
		typeof slugCond === 'string' ? a.referralSlug === slugCond : a.referralSlug.toLowerCase() === String(slugCond.equals).toLowerCase() && slugCond.mode === 'insensitive';
	const match = state.affiliates.find(a => slugMatches(a) || (byId && a.id === byId.id));
	if (match && args.where.user?.status && (match.status ?? 'ACTIVE') !== args.where.user.status) return null;
	return match ? { id: match.id, userId: match.userId } : null;
};
const create = async (args: any) => {
	if (state.createError) throw state.createError;
	if (state.referrals.some(r => r.referredUserId === args.data.referredUserId)) throw Object.assign(new Error('dup'), { code: 'P2002' });
	state.referrals.push({ id: `r-${state.referrals.length + 1}`, ...args.data });
	return state.referrals.at(-1);
};

let loaded: Promise<any> | undefined;
function load() {
	loaded ??= (async () => {
		mock.module('../repositories/auth.repository', {
			namedExports: { authRepository: { findByEmailOrPhone: async () => null, createUserWithProfile: async () => ({ id: 'new-user', email: 'new@example.com' }), createOtp: async () => ({}) } },
		});
		mock.module('../config/db', { namedExports: { prisma: { affiliateProfile: { findFirst }, referral: { create } } } });
		mock.module('../config/logger', { namedExports: { logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), debug: () => {} } } });
		mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });
		return (await import('./auth.service')).authService;
	})();
	return loaded;
}

const BASE: any = { accountType: 'CLIENT_INDIVIDUAL', firstName: 'Test', lastName: 'User', email: 'new@example.com', phoneCountryCode: '+966', phoneNumber: '500000001', password: 'Password1', agreedToTerms: true };
const KHALID: Affiliate = { id: 'aff-1', userId: 'aff-user-1', referralSlug: 'khalid2026' };

async function register(extra: any, cookie?: string) {
	state.referrals = [];
	state.createError = null;
	logs.length = 0;
	const svc = await load();
	return svc.registerUser({ ...BASE, ...extra }, { refCookieSlug: cookie });
}

test('a valid slug creates a PENDING referral for that marketer (what GET /marketer-overview/referrals lists)', async () => {
	state.affiliates = [KHALID];
	const res = await register({ affiliateIdentifier: 'khalid2026' });
	assert.equal(res.userId, 'new-user');
	assert.deepEqual(state.referrals.map(r => [r.affiliateId, r.referredUserId, r.status]), [['aff-1', 'new-user', 'PENDING']]);
});

test('a wrong slug never breaks registration and writes no referral', async () => {
	state.affiliates = [KHALID];
	const res = await register({ affiliateIdentifier: 'nobody' });
	assert.equal(res.userId, 'new-user');
	assert.equal(state.referrals.length, 0);
});

test('an inactive marketer is not credited, and registration still succeeds', async () => {
	state.affiliates = [{ ...KHALID, status: 'SUSPENDED' }];
	const res = await register({ affiliateIdentifier: 'khalid2026' }, 'khalid2026');
	assert.equal(res.userId, 'new-user');
	assert.equal(state.referrals.length, 0);
});

test('a typed slug with other casing or surrounding spaces still resolves (used to be dropped silently)', async () => {
	state.affiliates = [KHALID];
	await register({ affiliateIdentifier: '  Khalid2026 ' });
	assert.equal(state.referrals[0]?.affiliateId, 'aff-1');
});

test('a pasted referral link or @handle resolves to the slug (used to be dropped silently)', async () => {
	state.affiliates = [KHALID];
	await register({ affiliateIdentifier: 'https://dev.waseetai.com/ref/khalid2026?utm_source=x' });
	assert.equal(state.referrals[0]?.affiliateId, 'aff-1');
	await register({ affiliateIdentifier: '@khalid2026' });
	assert.equal(state.referrals[0]?.affiliateId, 'aff-1');
});

test('the cookie slug (httpOnly waseet_ref_code) attributes with no body field at all', async () => {
	state.affiliates = [KHALID];
	await register({}, 'khalid2026');
	assert.equal(state.referrals[0]?.affiliateId, 'aff-1');
});

test('a database error while writing the referral never fails registration (user already exists) and is logged', async () => {
	state.affiliates = [KHALID];
	const svc = await load();
	state.referrals = [];
	logs.length = 0;
	state.createError = Object.assign(new Error('column does not exist'), { code: 'P2022' });
	const res = await svc.registerUser({ ...BASE, affiliateIdentifier: 'khalid2026' }, {});
	state.createError = null;
	assert.equal(res.userId, 'new-user');
	assert.equal(state.referrals.length, 0);
	assert.ok(logs.some(l => l.includes('[Referral]')), 'the skipped attribution is logged');
});

test('a marketing broker signing up is never attributed', async () => {
	state.affiliates = [KHALID];
	await register({ accountType: 'MARKETING_BROKER', affiliateIdentifier: 'khalid2026' }, 'khalid2026');
	assert.equal(state.referrals.length, 0);
});

// Field name on the wire: the schema strips unknown keys without an error, so a differently named field was lost silently.
const body = (extra: any) => ({ ...BASE, ...extra });
const parse = (extra: any) => registerSchema.safeParse({ body: body(extra) });

test('schema: affiliateIdentifier is the field; referralSlug / referralCode are accepted aliases and map onto it', () => {
	for (const key of ['affiliateIdentifier', 'referralSlug', 'referralCode']) {
		const r = parse({ [key]: 'khalid2026' });
		assert.equal(r.success, true, key);
		assert.equal((r as any).data.body.affiliateIdentifier, 'khalid2026', key);
	}
});

test('schema: an explicit affiliateIdentifier wins over an alias; with none given the field stays absent', () => {
	assert.equal((parse({ affiliateIdentifier: 'a', referralSlug: 'b' }) as any).data.body.affiliateIdentifier, 'a');
	assert.equal((parse({}) as any).data.body.affiliateIdentifier, undefined);
});
