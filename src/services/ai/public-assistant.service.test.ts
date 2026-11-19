import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { askPublicAssistant, resetPublicAssistantCounter } from './public-assistant.service';

const client = (result: Record<string, unknown> | Error) => ({ publicAsk: async () => { if (result instanceof Error) throw result; return result; } }) as any;
const day = (d: string) => new Date(`${d}T10:00:00Z`);
test.beforeEach(() => { resetPublicAssistantCounter(); delete process.env.PUBLIC_ASSISTANT_DAILY_CAP; });

test('PUBLIC answers pass through; an empty PUBLIC answer becomes the fixed "not covered" message', async () => {
	assert.deepEqual(await askPublicAssistant({ question: 'مين وسيط؟' }, client({ scope: 'PUBLIC', answer: ' منصة تربط... ' })), { kind: 'ANSWER', answer: 'منصة تربط...', loginRequired: false });
	const empty = await askPublicAssistant({ question: 'x' }, client({ scope: 'PUBLIC', answer: '  ' }));
	assert.equal(empty.kind, 'NOT_COVERED'); assert.match(empty.answer, /اتصل بنا/);
});
test('ACCOUNT_REQUIRED never shows model text: a fixed sign-in message and loginRequired=true (Arabic and English)', async () => {
	const ar = await askPublicAssistant({ question: 'كيف أضبط إعدادات لوحة التحكم؟' }, client({ scope: 'ACCOUNT_REQUIRED', answer: 'نص الموديل' }));
	assert.equal(ar.loginRequired, true); assert.equal(ar.kind, 'LOGIN_REQUIRED'); assert.match(ar.answer, /سجّل دخولك/); assert.ok(!ar.answer.includes('نص الموديل'));
	const en = await askPublicAssistant({ question: 'How do I configure the dashboard API?', language: 'en' }, client({ scope: 'ACCOUNT_REQUIRED', answer: '' }));
	assert.equal(en.loginRequired, true); assert.match(en.answer, /sign in/i);
});
test('NOT_COVERED / OFF_TOPIC / unknown scope never ask for a sign-in; OFF_TOPIC keeps the short redirect', async () => {
	assert.equal((await askPublicAssistant({ question: 'كم الرسوم؟' }, client({ scope: 'NOT_COVERED', answer: '' }))).loginRequired, false);
	assert.deepEqual(await askPublicAssistant({ question: 'طقس اليوم' }, client({ scope: 'OFF_TOPIC', answer: 'أستطيع الحديث عن وسيط فقط.' })), { kind: 'OFF_TOPIC', answer: 'أستطيع الحديث عن وسيط فقط.', loginRequired: false });
	assert.equal((await askPublicAssistant({ question: 'x' }, client({ scope: 'WHATEVER', answer: 'y' }))).kind, 'NOT_COVERED');
});
test('the AI being down is a polite "busy" answer, not an error and not a sign-in prompt', async () => {
	const out = await askPublicAssistant({ question: 'مين وسيط؟' }, client(new Error('down')));
	assert.equal(out.kind, 'BUSY'); assert.equal(out.loginRequired, false);
});
test('invalid input is a 400: empty, too long, extra long history; unknown fields are ignored', async () => {
	await assert.rejects(() => askPublicAssistant({ question: '   ' }, client({})), (e: any) => e.statusCode === 400);
	await assert.rejects(() => askPublicAssistant({ question: 'x'.repeat(401) }, client({})), (e: any) => e.statusCode === 400);
	await assert.rejects(() => askPublicAssistant({ question: 'x', history: Array.from({ length: 5 }, () => ({ role: 'user', content: 'a' })) }, client({})), (e: any) => e.statusCode === 400);
	await assert.rejects(() => askPublicAssistant(undefined, client({})), (e: any) => e.statusCode === 400);
	assert.equal((await askPublicAssistant({ question: 'مين وسيط؟', isAdmin: true, userId: 'x' }, client({ scope: 'PUBLIC', answer: 'ok' }))).kind, 'ANSWER');
});
test('the daily ceiling stops model calls and resets the next UTC day', async () => {
	process.env.PUBLIC_ASSISTANT_DAILY_CAP = '2';
	let calls = 0; const counting = { publicAsk: async () => { calls++; return { scope: 'PUBLIC', answer: 'ok' }; } } as any;
	await askPublicAssistant({ question: 'a' }, counting, day('2026-11-18')); await askPublicAssistant({ question: 'b' }, counting, day('2026-11-18'));
	const blocked = await askPublicAssistant({ question: 'c' }, counting, day('2026-11-18'));
	assert.equal(blocked.kind, 'BUSY'); assert.equal(calls, 2);
	assert.equal((await askPublicAssistant({ question: 'd' }, counting, day('2026-11-19'))).kind, 'ANSWER'); assert.equal(calls, 3);
});
test('wiring: the route is public (no authenticate), uses the strict per-address tier, is mounted at /api/public-assistant and sends the visitor as a system actor with no account data', () => {
	const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf-8');
	const route = read('routes/public-assistant.routes.ts');
	assert.ok(route.includes("router.post('/ask', publicAiLimiter"));
	assert.ok(!/authenticate|requireActiveUser/.test(route.replace(/\/\/.*$/gm, '')));
	assert.ok(read('app.ts').includes("mountApiRoute('/public-assistant', publicAssistantRouter);"));
	const svc = read('services/ai/public-assistant.service.ts').replace(/\/\/.*$/gm, '');
	assert.ok(!/prisma|req\.user|userId:\s*req/.test(svc));
	assert.ok(read('middlewares/rate-limit.middleware.ts').includes("PUBLIC_AI: tierFromEnv('PUBLIC_AI', { windowMs: MIN15, user: 20, ip: 10, ipNet: 40 })"));
});
