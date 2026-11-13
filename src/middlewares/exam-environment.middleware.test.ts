import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { requireExamEnvironment, examEnvironmentStatus } from './exam-environment.middleware';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const BEK = sha('bek');
const res = () => { const r: any = { code: 200, body: null, headers: {} as Record<string, string> }; r.status = (c: number) => { r.code = c; return r; }; r.json = (b: unknown) => { r.body = b; return r; }; r.setHeader = (k: string, v: string) => { r.headers[k] = v; }; return r; };
const withEnv = async (env: Record<string, string | undefined>, fn: () => void | Promise<void>) => { const old: Record<string, string | undefined> = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } try { await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };
const run = (req: any) => { const r = res(); let nexted = false; requireExamEnvironment(req, r, () => { nexted = true; }); return { r, nexted }; };

test('default mode: nothing is restricted', () => withEnv({ EXAM_SEB_MODE: undefined }, () => { assert.equal(run({ headers: {}, originalUrl: '/x' }).nexted, true); }));
test('required but not configured: the exam cannot start (503, fail closed)', () => withEnv({ EXAM_SEB_MODE: 'required', EXAM_SEB_BROWSER_EXAM_KEYS: undefined, EXAM_SEB_CONFIG_KEYS: undefined, FRONTEND_URL: 'https://h.test' }, () => {
	const { r, nexted } = run({ headers: {}, originalUrl: '/api/assessments/generate' }); assert.equal(nexted, false); assert.equal(r.code, 503); assert.equal(r.body.code, 'EXAM_ENVIRONMENT_NOT_CONFIGURED');
}));
test('required: no / wrong hash => 403 and nothing proceeds; a valid hash proceeds', () => withEnv({ EXAM_SEB_MODE: 'required', EXAM_SEB_BROWSER_EXAM_KEYS: BEK, FRONTEND_URL: 'https://h.test' }, () => {
	const denied = run({ headers: { 'user-agent': 'SEB' }, originalUrl: '/api/assessments/generate' }); assert.equal(denied.nexted, false); assert.equal(denied.r.code, 403); assert.equal(denied.r.body.code, 'EXAM_ENVIRONMENT_REQUIRED');
	const ok = run({ headers: { 'x-safeexam-requesthash': sha('https://h.test/api/assessments/generate' + BEK) }, originalUrl: '/api/assessments/generate' }); assert.equal(ok.nexted, true);
}));
test('status: reports the mode and whether this request is verified, never a key', () => withEnv({ EXAM_SEB_MODE: 'required', EXAM_SEB_BROWSER_EXAM_KEYS: BEK, FRONTEND_URL: 'https://h.test' }, () => {
	const r = res(); examEnvironmentStatus({ headers: {}, originalUrl: '/api/assessments/exam-environment' } as any, r);
	assert.equal(r.body.data.mode, 'required'); assert.equal(r.body.data.verified, false); assert.equal(r.body.data.ready, true);
	assert.match(r.body.data.configUrl, /^sebs:\/\/h\.test\/api\/exam-environment\/seb-config$/);
	assert.ok(!JSON.stringify(r.body).includes(BEK));
	assert.equal(r.body.data.supportedSystems.find((s: any) => s.system === 'Android').supported, false);
}));
