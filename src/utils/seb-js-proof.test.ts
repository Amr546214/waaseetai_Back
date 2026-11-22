import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import { exchangeSebJsChallenge, issueSebJsChallenge, SEB_CHALLENGE_PARAM, verifySebAccessProof } from './seb-js-proof';
import { TicketUseStore } from './exam-ticket';
import { examEnvStatus } from './seb-exam';
import { examSigningSecret } from './exam-signing';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const BEK = sha('test-BEK'), CK = sha('test-CK');
const file = join(mkdtempSync(join(tmpdir(), 'seb-modern-')), 'exam.seb'); writeFileSync(file, 'approved test file');
const ENV = { EXAM_SEB_MODE: 'required', EXAM_SEB_JS_API_ENABLED: 'true', EXAM_SEB_BROWSER_EXAM_KEYS: BEK, EXAM_SEB_CONFIG_KEYS: CK, EXAM_PUBLIC_ORIGIN: 'https://exam.test', EXAM_SEB_CONFIG_FILE: file, EXAM_SEB_CONFIG_FILE_SHA256: sha('approved test file'), JWT_SECRET: 'isolated-test-secret-not-a-runtime-value' };
const USER = { id: 'provider-A', sessionId: 'session-A' };
const store = () => { const used = new Set<string>(); return { async claim(jti) { if (used.has(jti)) return false; used.add(jti); return true; } } satisfies TicketUseStore; };
function nativeReply(url: string) {
  return { challenge: new URL(url).searchParams.get(SEB_CHALLENGE_PARAM)!, browserExamKeyHash: sha(url + BEK), configKeyHash: sha(url + CK) };
}
const challenge = () => issueSebJsChallenge(USER, '/provider-overview/profile/specialties?takeTest=S1', ENV)!;

test('modern protocol: fresh native page hash yields a session-bound proof, not an API URL hash', async () => {
  const c = challenge(); assert.ok(c.url.startsWith('https://exam.test/provider-overview/profile/specialties?takeTest=S1&'));
  const p = await exchangeSebJsChallenge(USER, nativeReply(c.url), ENV, store()); assert.ok(p);
  assert.equal(verifySebAccessProof(p.proof, USER, ENV), true);
  assert.equal(verifySebAccessProof(p.proof, { ...USER, id: 'provider-B' }, ENV), false);
  assert.equal(verifySebAccessProof(p.proof, { ...USER, sessionId: 'another-login' }, ENV), false);
  assert.equal(verifySebAccessProof(p.proof, { id: USER.id }, ENV), false);
  assert.equal(verifySebAccessProof(p.proof, undefined, ENV), false);
  assert.equal(verifySebAccessProof(c.url.split(SEB_CHALLENGE_PARAM + '=')[1], USER, ENV), false, 'a challenge cannot be used as an access proof');
  assert.equal(JSON.stringify(jwt.decode(p.proof)).includes(BEK), false);
  assert.throws(() => jwt.verify(p.proof, ENV.JWT_SECRET), 'an exam proof is not a login credential');
  assert.throws(() => jwt.verify(nativeReply(c.url).challenge, ENV.JWT_SECRET), 'a URL challenge is not a login credential');
});

test('a static page hash, made-up JS object, changed key or changed document URL cannot pass', async () => {
  const c = challenge(); const reply = nativeReply(c.url);
  for (const input of [
    { ...reply, browserExamKeyHash: BEK },
    { ...reply, browserExamKeyHash: sha('https://exam.test/provider-overview/profile/specialties' + BEK) },
    { ...reply, browserExamKeyHash: sha(c.url + 'wrong-key') },
    { ...reply, browserExamKeyHash: sha(c.url + BEK).slice(1) },
    { ...reply, configKeyHash: sha(c.url + 'wrong-config') },
    { ...reply, configKeyHash: '' },
    { challenge: reply.challenge, isSeb: true, userAgent: 'SafeExamBrowser' },
    { ...reply, challenge: reply.challenge.slice(0, -1) + '!' }
  ]) assert.equal(await exchangeSebJsChallenge(USER, input, ENV, store()), null);
});

test('a challenge is single-use across consumers; invalid proof does not consume it', async () => {
  const c = challenge(), s = store(), reply = nativeReply(c.url);
  assert.equal(await exchangeSebJsChallenge(USER, { ...reply, configKeyHash: 'bad' }, ENV, s), null);
  const results = await Promise.all([exchangeSebJsChallenge(USER, reply, ENV, s), exchangeSebJsChallenge(USER, reply, ENV, s)]);
  assert.equal(results.filter(Boolean).length, 1);
});

test('fresh challenge cannot be exchanged from a different user/login, or when replay storage fails', async () => {
  const reply = nativeReply(challenge().url);
  assert.equal(await exchangeSebJsChallenge({ ...USER, sessionId: 'session-B' }, reply, ENV, store()), null);
  assert.equal(await exchangeSebJsChallenge({ ...USER, id: 'provider-B' }, reply, ENV, store()), null);
  assert.equal(await exchangeSebJsChallenge(USER, reply, ENV, { claim: async () => { throw new Error('database unavailable'); } }), null);
});

test('feature is opt-in, needs BEK + approved file + login, and rotation revokes existing access', async () => {
  const p = await exchangeSebJsChallenge(USER, nativeReply(challenge().url), ENV, store()); assert.ok(p);
  for (const env of [
    { ...ENV, EXAM_SEB_JS_API_ENABLED: 'false' }, { ...ENV, EXAM_SEB_MODE: 'off' },
    { ...ENV, EXAM_SEB_CONFIG_FILE_SHA256: sha('other file') },
    { ...ENV, EXAM_SEB_BROWSER_EXAM_KEYS: '' }, { ...ENV, EXAM_SEB_CONFIG_KEYS: sha('rotated') },
    { ...ENV, JWT_SECRET: 'rotated-signing-key' }
  ]) {
    assert.equal(verifySebAccessProof(p.proof, USER, env), false);
    assert.equal(await exchangeSebJsChallenge(USER, nativeReply(challenge().url), env, store()), null);
  }
  assert.equal(examEnvStatus({ ...ENV, EXAM_SEB_BROWSER_EXAM_KEYS: '' }).ready, false, 'config-only is not enough for modern verification');
  assert.equal(issueSebJsChallenge({ id: USER.id }, '/provider-overview/profile/specialties', ENV), null);
});

test('no arbitrary origin, path, fragment or injected challenge URL is accepted', () => {
  for (const path of ['https://attacker.test', '//attacker.test/x', '/auth/login', '/provider-overview/../api/health', '/provider-overview/\\attacker.test', '/provider-overview/x#fragment', '/provider-overview/x\n', null]) assert.equal(issueSebJsChallenge(USER, path, ENV), null);
  const c = issueSebJsChallenge(USER, '/provider-overview/profile/setup?_seb_challenge=forged&x=1', ENV)!;
  assert.ok(c); assert.notEqual(new URL(c.url).searchParams.get(SEB_CHALLENGE_PARAM), 'forged');
  assert.equal(new URL(c.url).searchParams.getAll(SEB_CHALLENGE_PARAM).length, 1);
});

test('expired challenge and access JWTs fail closed even when correctly signed', async () => {
  const reply = nativeReply(challenge().url);
  const decoded = jwt.decode(reply.challenge) as jwt.JwtPayload; delete decoded.iat; delete decoded.exp;
  const expired = jwt.sign(decoded, examSigningSecret(ENV, 'seb-js-v1'), { expiresIn: -1 });
  assert.equal(await exchangeSebJsChallenge(USER, { ...reply, challenge: expired }, ENV, store()), null);
  const p = await exchangeSebJsChallenge(USER, reply, ENV, store()); assert.ok(p);
  const payload = jwt.decode(p.proof) as jwt.JwtPayload; delete payload.iat; delete payload.exp;
  assert.equal(verifySebAccessProof(jwt.sign(payload, examSigningSecret(ENV, 'seb-js-v1'), { expiresIn: -1 }), USER, ENV), false);
});
