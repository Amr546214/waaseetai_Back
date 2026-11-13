import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySebRequest, examEnvStatus, buildSebTemplate, candidateUrls, approvedSebConfig, SEB_TEMPLATE_KEY_NOTES } from './seb-exam';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const BEK = sha('browser-exam-key-of-the-test'), CFG = sha('config-key-of-the-test');
const dir = mkdtempSync(join(tmpdir(), 'seb-'));
const FILE = join(dir, 'approved.seb'); const FILE_BYTES = Buffer.from('<plist>approved-by-the-config-tool</plist>');
writeFileSync(FILE, FILE_BYTES);
const FILE_SHA = createHash('sha256').update(FILE_BYTES).digest('hex');
const ENV = { EXAM_SEB_MODE: 'required', EXAM_SEB_BROWSER_EXAM_KEYS: BEK, EXAM_SEB_CONFIG_KEYS: CFG, FRONTEND_URL: 'https://dev.example.com/', EXAM_SEB_CONFIG_FILE: FILE, EXAM_SEB_CONFIG_FILE_SHA256: FILE_SHA } as NodeJS.ProcessEnv;
const req = (url: string, headers: Record<string, string> = {}) => ({ originalUrl: url, url, headers }) as any;

test('mode off (default) is not restricted and never "ready"; required needs keys and an origin (fail closed)', () => {
	assert.deepEqual(examEnvStatus({} as NodeJS.ProcessEnv), { mode: 'off', ready: false, missing: [], testedInRealSeb: false, testedNote: null });
	const noKeys = examEnvStatus({ EXAM_SEB_MODE: 'required', FRONTEND_URL: 'https://x.test' } as NodeJS.ProcessEnv);
	assert.equal(noKeys.ready, false); assert.match(noKeys.missing.join(' '), /EXAM_SEB_BROWSER_EXAM_KEYS/);
	assert.equal(examEnvStatus({ EXAM_SEB_MODE: 'required', EXAM_SEB_BROWSER_EXAM_KEYS: 'not-hex' } as NodeJS.ProcessEnv).ready, false, 'a malformed key counts as no key');
	assert.deepEqual(examEnvStatus(ENV), { mode: 'required', ready: true, missing: [], testedInRealSeb: false, testedNote: null });
	assert.equal(examEnvStatus({ ...ENV, EXAM_SEB_TESTED_IN_REAL_SEB: 'Windows SEB 3.7 on 2026-11-20' } as NodeJS.ProcessEnv).testedInRealSeb, true);
});
test('a Browser Exam Key hash of THIS URL verifies; the same hash on another URL, with another key, or without the header does not', () => {
	const url = 'https://dev.example.com/api/assessments/generate';
	assert.deepEqual(verifySebRequest(req('/api/assessments/generate', { 'x-safeexambrowser-requesthash': sha(url + BEK) }), ENV), { verified: true, via: 'browser-exam-key' });
	assert.equal(verifySebRequest(req('/api/assessments/active', { 'x-safeexambrowser-requesthash': sha(url + BEK) }), ENV).verified, false, 'a hash is bound to its URL (no replay on another route)');
	assert.equal(verifySebRequest(req('/api/assessments/generate', { 'x-safeexambrowser-requesthash': sha(url + sha('other')) }), ENV).verified, false);
	assert.equal(verifySebRequest(req('/api/assessments/generate'), ENV).verified, false);
	assert.equal(verifySebRequest(req('/api/assessments/generate', { 'x-safeexambrowser-requesthash': 'zz' }), ENV).verified, false);
});
test('the Config Key hash works too; query strings are part of the URL; a proxy that strips /api is accepted', () => {
	const url = 'https://dev.example.com/api/assessments/active?x=1';
	assert.deepEqual(verifySebRequest(req('/api/assessments/active?x=1', { 'x-safeexambrowser-configkeyhash': sha(url + CFG) }), ENV), { verified: true, via: 'config-key' });
	assert.equal(verifySebRequest(req('/api/assessments/active?x=2', { 'x-safeexambrowser-configkeyhash': sha(url + CFG) }), ENV).verified, false);
	assert.equal(verifySebRequest(req('/assessments/active', { 'x-safeexambrowser-requesthash': sha('https://dev.example.com/api/assessments/active' + BEK) }), ENV).verified, true, 'the browser asked for /api/...; the proxy passed /assessments/...');
	assert.deepEqual(candidateUrls({ originalUrl: '/api/a' }, 'https://h.test'), ['https://h.test/api/a']);
});
test('NOT trusted: the User-Agent, a "SEB" claim, or a key presented as the hash', () => {
	const r = req('/api/assessments/generate', { 'user-agent': 'Mozilla/5.0 SEB/3.5 SafeExamBrowser', 'x-safeexam-browserexamkey': BEK, 'x-seb': 'true' });
	assert.equal(verifySebRequest(r, ENV).verified, false);
	assert.equal(verifySebRequest(req('/api/assessments/generate', { 'x-safeexambrowser-requesthash': BEK }), ENV).verified, false, 'the key itself is not a hash of the URL');
});
test('the older header spellings are accepted as aliases of the same cryptographic check', () => {
	const url = 'https://dev.example.com/api/assessments/generate';
	assert.equal(verifySebRequest(req('/api/assessments/generate', { 'x-safeexam-requesthash': sha(url + BEK) }), ENV).verified, true);
	assert.equal(verifySebRequest(req('/api/assessments/generate', { 'x-safeexam-configkeyhash': sha(url + CFG) }), ENV).verified, true);
});
test('the file users download is the approved one: served only while its SHA-256 equals the digest recorded with the keys; never generated', () => {
	const ok = approvedSebConfig(ENV); assert.equal(ok.ok, true); if (ok.ok) { assert.equal(ok.sha256, FILE_SHA); assert.deepEqual(ok.bytes, FILE_BYTES); }
	assert.deepEqual(approvedSebConfig({ ...ENV, EXAM_SEB_CONFIG_FILE_SHA256: sha('another file') } as NodeJS.ProcessEnv), { ok: false, reason: 'DIGEST_MISMATCH' });
	assert.deepEqual(approvedSebConfig({ ...ENV, EXAM_SEB_CONFIG_FILE_SHA256: undefined } as NodeJS.ProcessEnv), { ok: false, reason: 'DIGEST_NOT_SET' });
	assert.deepEqual(approvedSebConfig({ ...ENV, EXAM_SEB_CONFIG_FILE: join(dir, 'missing.seb') } as NodeJS.ProcessEnv), { ok: false, reason: 'UNREADABLE' });
	assert.deepEqual(approvedSebConfig({} as NodeJS.ProcessEnv), { ok: false, reason: 'NOT_SET' });
	// keys without the approved file (or with a different one) are NOT "ready": users could not get the settings the keys belong to
	const noFile = examEnvStatus({ ...ENV, EXAM_SEB_CONFIG_FILE: undefined } as NodeJS.ProcessEnv); assert.equal(noFile.ready, false); assert.match(noFile.missing.join(' '), /EXAM_SEB_CONFIG_FILE/);
	const wrong = examEnvStatus({ ...ENV, EXAM_SEB_CONFIG_FILE_SHA256: sha('other') } as NodeJS.ProcessEnv); assert.equal(wrong.ready, false); assert.match(wrong.missing.join(' '), /not the approved file/);
});
test('the template (a starting point for the SEB Config Tool) uses the official key spellings: URLFilterRules with action/active/expression/regex, content filter on, no secret', () => {
	const xml = buildSebTemplate('https://dev.example.com');
	assert.match(xml, /<key>URLFilterRules<\/key>/); assert.doesNotMatch(xml, /<key>urlFilterRules<\/key>/);
	for (const k of ['action', 'active', 'expression', 'regex']) assert.match(xml, new RegExp(`<key>${k}</key>`));
	assert.match(xml, /<string>dev\.example\.com<\/string>/); assert.match(xml, /<string>dev\.example\.com\/\*<\/string>/);
	assert.match(xml, /<key>URLFilterEnableContentFilter<\/key>\s*<true\/>/);
	assert.match(xml, /<key>startURL<\/key>\s*<string>https:\/\/dev\.example\.com\/provider-overview\/profile\/specialties<\/string>/);
	for (const k of ['enablePrintScreen', 'allowScreenSharing', 'allowVirtualMachine', 'allowScreenCapture', 'allowWindowCapture']) assert.match(xml, new RegExp(`<key>${k}</key>\\s*<false/>`));
	assert.match(xml, /<key>blockScreenShotsLegacy<\/key>\s*<true\/>/);
	assert.ok(!xml.includes(BEK) && !xml.includes(CFG));
	// every key written is documented with its verification level
	for (const m of xml.matchAll(/<key>([A-Za-z]+)<\/key>/g)) if (!['action', 'active', 'expression', 'regex'].includes(m[1])) assert.ok(SEB_TEMPLATE_KEY_NOTES[m[1]], `${m[1]} has no verification note`);
});
