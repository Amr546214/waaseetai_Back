import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifySebRequest, examEnvStatus, buildSebConfig, candidateUrls } from './seb-exam';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const BEK = sha('browser-exam-key-of-the-test'), CFG = sha('config-key-of-the-test');
const ENV = { EXAM_SEB_MODE: 'required', EXAM_SEB_BROWSER_EXAM_KEYS: BEK, EXAM_SEB_CONFIG_KEYS: CFG, FRONTEND_URL: 'https://dev.example.com/' } as NodeJS.ProcessEnv;
const req = (url: string, headers: Record<string, string> = {}) => ({ originalUrl: url, url, headers }) as any;

test('mode off (default) is not restricted and never "ready"; required needs keys and an origin (fail closed)', () => {
	assert.deepEqual(examEnvStatus({} as NodeJS.ProcessEnv), { mode: 'off', ready: false, missing: [] });
	const noKeys = examEnvStatus({ EXAM_SEB_MODE: 'required', FRONTEND_URL: 'https://x.test' } as NodeJS.ProcessEnv);
	assert.equal(noKeys.ready, false); assert.match(noKeys.missing.join(' '), /EXAM_SEB_BROWSER_EXAM_KEYS/);
	assert.equal(examEnvStatus({ EXAM_SEB_MODE: 'required', EXAM_SEB_BROWSER_EXAM_KEYS: 'not-hex' } as NodeJS.ProcessEnv).ready, false, 'a malformed key counts as no key');
	assert.deepEqual(examEnvStatus(ENV), { mode: 'required', ready: true, missing: [] });
});
test('a Browser Exam Key hash of THIS URL verifies; the same hash on another URL, with another key, or without the header does not', () => {
	const url = 'https://dev.example.com/api/assessments/generate';
	assert.deepEqual(verifySebRequest(req('/api/assessments/generate', { 'x-safeexam-requesthash': sha(url + BEK) }), ENV), { verified: true, via: 'browser-exam-key' });
	assert.equal(verifySebRequest(req('/api/assessments/active', { 'x-safeexam-requesthash': sha(url + BEK) }), ENV).verified, false, 'a hash is bound to its URL (no replay on another route)');
	assert.equal(verifySebRequest(req('/api/assessments/generate', { 'x-safeexam-requesthash': sha(url + sha('other')) }), ENV).verified, false);
	assert.equal(verifySebRequest(req('/api/assessments/generate'), ENV).verified, false);
	assert.equal(verifySebRequest(req('/api/assessments/generate', { 'x-safeexam-requesthash': 'zz' }), ENV).verified, false);
});
test('the Config Key hash works too; query strings are part of the URL; a proxy that strips /api is accepted', () => {
	const url = 'https://dev.example.com/api/assessments/active?x=1';
	assert.deepEqual(verifySebRequest(req('/api/assessments/active?x=1', { 'x-safeexam-configkeyhash': sha(url + CFG) }), ENV), { verified: true, via: 'config-key' });
	assert.equal(verifySebRequest(req('/api/assessments/active?x=2', { 'x-safeexam-configkeyhash': sha(url + CFG) }), ENV).verified, false);
	assert.equal(verifySebRequest(req('/assessments/active', { 'x-safeexam-requesthash': sha('https://dev.example.com/api/assessments/active' + BEK) }), ENV).verified, true, 'the browser asked for /api/...; the proxy passed /assessments/...');
	assert.deepEqual(candidateUrls({ originalUrl: '/api/a' }, 'https://h.test'), ['https://h.test/api/a']);
});
test('NOT trusted: the User-Agent, a "SEB" claim, or a key presented as the hash', () => {
	const r = req('/api/assessments/generate', { 'user-agent': 'Mozilla/5.0 SEB/3.5 SafeExamBrowser', 'x-safeexam-browserexamkey': BEK, 'x-seb': 'true' });
	assert.equal(verifySebRequest(r, ENV).verified, false);
	assert.equal(verifySebRequest(req('/api/assessments/generate', { 'x-safeexam-requesthash': BEK }), ENV).verified, false, 'the key itself is not a hash of the URL');
});
test('the SEB settings file carries the origin and the restrictions and NO key or secret', () => {
	const xml = buildSebConfig('https://dev.example.com');
	assert.match(xml, /<key>startURL<\/key>\s*<string>https:\/\/dev\.example\.com\/provider-overview\/profile\/specialties<\/string>/);
	assert.match(xml, /<key>enablePrintScreen<\/key>\s*<false\/>/); assert.match(xml, /<key>allowScreenSharing<\/key>\s*<false\/>/); assert.match(xml, /<key>allowVirtualMachine<\/key>\s*<false\/>/);
	assert.ok(!xml.includes(BEK) && !xml.includes(CFG));
	assert.match(xml, /dev\.example\.com/);
});
