import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Opt-in DEV fallback of the onboarding setup test (SETUP_TEST_DEV_FALLBACK === 'true' AND the WaseetAI call failed). Real gateway + real
// completeSetupTest / onboarding sample / access-state; only the database, the socket auth and the WaseetAI client are replaced.
type Any = Record<string, any>;
const S: Any = {};
const ai: Any = { mode: 'fail', submitCalls: 0, streamCalls: 0 };
function reset() {
	let n = 0; S.seq = () => `id-${++n}`;
	S.user = { id: 'u1', accountType: 'PROVIDER_INDIVIDUAL' };
	S.profile = { id: 'pp1', userId: 'u1', isProfileSetupComplete: true, setupTestStatus: 'NOT_STARTED', setupTestScore: null, setupTestBannedUntil: null, mainSpecialty: 'design-creative', industry: null, subSpecialties: ['تصميم جرافيك'] };
	S.catalog = [{ id: 'sp-g', nameAr: 'تصميم جرافيك', name: 'تصميم جرافيك', nameEn: 'Graphic', isActive: true }];
	S.ps = []; S.samples = [];
	S.portfolio = [{ providerProfileId: 'pp1', title: 'نموذج أعمال - تصميم جرافيك', description: 'https://res.cloudinary.com/w/work.pdf', coverImage: 'https://res.cloudinary.com/w/p.png', projectUrl: null, tags: ['https://res.cloudinary.com/w/p.png'] }];
	ai.mode = 'fail'; ai.submitCalls = 0; ai.streamCalls = 0;
}
const matches = (row: Any, where: Any = {}) => Object.entries(where).every(([k, v]) => v && typeof v === 'object' && 'startsWith' in (v as Any) ? String(row[k]).startsWith((v as Any).startsWith) : row[k] === v);
const withSamples = (r: Any) => ({ ...r, specialty: S.catalog.find((c: Any) => c.id === r.specialtyId), accreditationSamples: S.samples.filter((s: Any) => s.providerSpecialtyId === r.id) });
const db: Any = {
	user: { findUnique: async () => S.user },
	category: { findFirst: async () => null },
	providerProfile: { update: async ({ data }: Any) => Object.assign(S.profile, data), findUnique: async ({ where }: Any) => (where.userId ? (where.userId === 'u1' ? S.profile : null) : where.id === 'pp1' ? S.profile : null) },
	specialty: { findMany: async ({ where }: Any) => S.catalog.filter((c: Any) => where.nameAr.in.includes(c.nameAr)) },
	portfolioItem: { findMany: async ({ where }: Any) => S.portfolio.filter((p: Any) => matches(p, where)) },
	providerSpecialty: {
		findUnique: async ({ where }: Any) => { const k = where.providerProfileId_specialtyId; return S.ps.find((r: Any) => r.providerProfileId === k.providerProfileId && r.specialtyId === k.specialtyId) ?? null; },
		upsert: async ({ where, create }: Any) => { const k = where.providerProfileId_specialtyId; const hit = S.ps.find((r: Any) => r.providerProfileId === k.providerProfileId && r.specialtyId === k.specialtyId); if (hit) return hit; const row = { id: S.seq(), isActive: true, isPassed: false, createdAt: new Date(), ...create }; S.ps.push(row); return row; },
		findMany: async ({ where }: Any) => S.ps.filter((r: Any) => r.providerProfileId === where.providerProfileId && r.isActive).map(withSamples),
		update: async ({ where, data }: Any) => { Object.assign(S.ps.find((r: Any) => r.id === where.id), data); return {}; },
		updateMany: async ({ where, data }: Any) => { const rows = S.ps.filter((r: Any) => r.id === where.id); rows.forEach((r: Any) => Object.assign(r, data)); return { count: rows.length }; },
	},
	accreditationSample: {
		findFirst: async ({ where }: Any) => S.samples.find((s: Any) => matches(s, where)) ?? null,
		count: async ({ where }: Any) => S.samples.filter((x: Any) => matches(x, where)).length,
		create: async ({ data }: Any) => { const s = { id: S.seq(), createdAt: new Date(), aiFeedbackAr: null, ...data }; S.samples.push(s); return s; },
		update: async ({ where, data }: Any) => Object.assign(S.samples.find((x: Any) => x.id === where.id), data),
	},
	accountAuditLog: { findFirst: async () => null },
};
mock.module('../config/db', { namedExports: { prisma: db } });
mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
mock.module('../utils/socket-auth', { namedExports: { verifySocketToken: async () => ({ ok: true, userId: 'u1' }) } });
mock.module('../services/ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: {
	streamAssessmentQuestions: async function* () {
		ai.streamCalls += 1;
		if (ai.mode === 'fail') { const e: any = new Error('auth'); e.code = 'AUTHENTICATION_ERROR'; throw e; }
		for (const id of [1, 2]) yield { type: 'question', attemptId: 'att1', question: { id, textAr: `سؤال ${id}`, options: [{ id: 'o1', text: 'أ' }, { id: 'o2', text: 'ب' }] } };
		yield { type: 'assessment_ready', attemptId: 'att1', totalQuestions: 2 };
	},
	submitAssessment: async () => { ai.submitCalls += 1; return { score: 100 }; },
} } });

function fakeSocket() {
	const handlers: Any = {}; const emitted: Array<[string, any]> = [];
	return { handlers, emitted, on: (e: string, f: any) => { handlers[e] = f; }, once() {}, off() {}, emit: (e: string, p: any) => { emitted.push([e, p]); } } as any;
}
const load = async () => ({
	gw: new (await import('./setup-test.gateway.ts')).SetupTestGateway(),
	bank: await import('../constants/setup-test-dev-fallback.ts'),
	access: (await import('../services/provider-access-state.service.ts')).providerAccessStateService,
});
const last = (sock: Any, ev: string) => [...sock.emitted].reverse().find(([e]: any) => e === ev)?.[1];
async function start(gw: any) { const sock = fakeSocket(); gw.register(sock); await sock.handlers['setup_test:init']({ token: 't' }); return sock; }
async function answerAll(sock: Any, pick: (i: number, q: Any) => number) {
	let i = 0;
	while (true) {
		await sock.handlers['setup_test:get_question']({ token: 't' });
		const q = last(sock, 'setup_test:question');
		if (!q || q.index !== i) break;
		await sock.handlers['setup_test:answer']({ token: 't', questionId: q.id, selectedIndex: pick(i, q) });
		i += 1;
		if (last(sock, 'setup_test:result')) break;
	}
}
const withFlag = async (v: string | undefined, fn: () => Promise<void>) => { const old = process.env.SETUP_TEST_DEV_FALLBACK; if (v === undefined) delete process.env.SETUP_TEST_DEV_FALLBACK; else process.env.SETUP_TEST_DEV_FALLBACK = v; try { await fn(); } finally { if (old === undefined) delete process.env.SETUP_TEST_DEV_FALLBACK; else process.env.SETUP_TEST_DEV_FALLBACK = old; } };

test('flag off (unset) + WaseetAI failure => today\'s error, no session, nothing written', async () => {
	reset(); const { gw } = await load();
	await withFlag(undefined, async () => {
		const sock = await start(gw);
		assert.equal(last(sock, 'setup_test:error').message, 'تعذّر إنشاء أسئلة الاختبار حالياً. يرجى المحاولة مرة أخرى بعد قليل.');
		assert.equal(last(sock, 'setup_test:ready'), undefined);
		assert.equal((gw as any).testSessions.size, 0);
		assert.deepEqual([S.profile.setupTestStatus, S.samples.length, S.ps.length], ['NOT_STARTED', 0, 0]);
	});
});

for (const v of ['TRUE', '1', 'yes', 'false', '']) {
	test(`flag '${v}' is OFF (only the exact string 'true' enables the fallback)`, async () => {
		reset(); const { gw, bank } = await load();
		await withFlag(v, async () => {
			assert.equal(bank.isSetupTestDevFallbackEnabled(), false);
			const sock = await start(gw);
			assert.ok(last(sock, 'setup_test:error')); assert.equal(last(sock, 'setup_test:ready'), undefined);
		});
	});
}

test("flag 'true' + WaseetAI OK => the WaseetAI path is used (no fallback), source not set", async () => {
	reset(); ai.mode = 'ok'; const { gw } = await load();
	await withFlag('true', async () => {
		const sock = await start(gw);
		assert.equal(last(sock, 'setup_test:ready').totalQuestions, 2);
		assert.equal((gw as any).testSessions.get('u1').source, 'AI');
		await answerAll(sock, () => 0);
		assert.equal(ai.submitCalls, 1);
		const res = last(sock, 'setup_test:result');
		assert.equal(res.score, 100); assert.equal('source' in res, false);
	});
});

test("flag 'true' + WaseetAI failure => 15 local questions (no key leaked), local grading, source DEV_FALLBACK, completes like the AI path", async () => {
	reset(); const { gw, bank, access } = await load();
	await withFlag('true', async () => {
		const sock = await start(gw);
		assert.equal(last(sock, 'setup_test:generating') !== undefined, true);
		assert.equal(last(sock, 'setup_test:ready').totalQuestions, 15);
		assert.equal((gw as any).testSessions.get('u1').source, 'DEV_FALLBACK');
		assert.equal(S.profile.setupTestStatus, 'NOT_STARTED');
		assert.equal(S.samples.length, 0);
		const seen: Any[] = [];
		await answerAll(sock, (i, q) => { seen.push(q); const fq = bank.SETUP_TEST_DEV_FALLBACK_QUESTIONS[i]; return fq.options.findIndex(o => o.id === fq.correctOptionId); });
		assert.equal(seen.length, 15);
		for (const q of seen) { assert.deepEqual(Object.keys(q).sort(), ['id', 'index', 'options', 'text', 'total']); assert.ok(q.options.every((o: unknown) => typeof o === 'string')); }
		assert.equal(ai.submitCalls, 0); // WaseetAI submit never called
		const res = last(sock, 'setup_test:result');
		assert.deepEqual([res.score, res.total, res.source], [100, 15, 'DEV_FALLBACK']);
		// identical completion semantics
		assert.deepEqual([S.profile.setupTestStatus, S.profile.setupTestScore], ['COMPLETED', 100]);
		const ps = S.ps[0];
		assert.deepEqual([ps.hasTakenAssessment, ps.isPassed, ps.status], [true, true, 'UNDER_AI_REVIEW']);
		assert.deepEqual([S.samples.length, S.samples[0].status, S.samples[0].providerProfileId, S.samples[0].providerSpecialtyId], [1, 'MANUAL_REVIEW', 'pp1', ps.id]);
		const st = await access.get('u1', db);
		assert.deepEqual([st.state, st.canAccessDashboard], ['PENDING_REVIEW', false]);
	});
});

test('local grading is real arithmetic: all wrong = 0, mixed = correct/total*100', async () => {
	const { bank } = await load();
	const wrongIdx = (i: number) => bank.SETUP_TEST_DEV_FALLBACK_QUESTIONS[i].options.findIndex(o => o.id !== bank.SETUP_TEST_DEV_FALLBACK_QUESTIONS[i].correctOptionId);
	const rightIdx = (i: number) => bank.SETUP_TEST_DEV_FALLBACK_QUESTIONS[i].options.findIndex(o => o.id === bank.SETUP_TEST_DEV_FALLBACK_QUESTIONS[i].correctOptionId);
	for (const [rightCount, expected] of [[0, 0], [6, 40], [9, 60]] as const) {
		reset(); const { gw } = await load();
		await withFlag('true', async () => {
			const sock = await start(gw);
			await answerAll(sock, (i) => (i < rightCount ? rightIdx(i) : wrongIdx(i)));
			assert.equal(last(sock, 'setup_test:result').score, expected, `${rightCount} right`);
			assert.equal(S.profile.setupTestScore, expected);
			assert.equal(S.ps[0].isPassed, expected > 25);
		});
	}
});

test('the local bank: exactly SETUP_TEST_QUESTION_COUNT items, unique ids, >=2 options, exactly one correct, no duplicates', async () => {
	const { bank } = await load();
	const { SETUP_TEST_QUESTION_COUNT } = await import('./setup-test.gateway.ts');
	const qs = bank.SETUP_TEST_DEV_FALLBACK_QUESTIONS;
	assert.equal(qs.length, SETUP_TEST_QUESTION_COUNT);
	assert.equal(new Set(qs.map(q => q.id)).size, qs.length);
	assert.equal(new Set(qs.map(q => q.textAr)).size, qs.length);
	for (const q of qs) {
		assert.ok(q.options.length >= 2 && q.textAr.trim());
		assert.equal(new Set(q.options.map(o => o.id)).size, q.options.length);
		assert.equal(new Set(q.options.map(o => o.text)).size, q.options.length);
		assert.equal(q.options.filter(o => o.id === q.correctOptionId).length, 1);
	}
	assert.ok(new Set(qs.map(q => q.correctOptionId)).size > 1, 'the key is not always the same option');
});

test('the flag is not committed anywhere in env / config / docker files', async () => {
	const { execSync } = await import('node:child_process');
	const out = execSync("git grep -l SETUP_TEST_DEV_FALLBACK -- . ':!src' || true", { cwd: new URL('../../', import.meta.url).pathname }).toString().trim();
	assert.equal(out, '');
});
