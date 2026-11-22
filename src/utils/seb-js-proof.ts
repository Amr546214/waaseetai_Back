import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { examEnvStatus, examPublicOrigin, sebKeys } from './seb-exam';
import { durableExamTicketUses, TicketUseStore } from './exam-ticket';
import { examSigningSecret } from './exam-signing';

// Official protocol: https://safeexambrowser.org/developer/seb-config-key.html
// Modern WebKit exposes SHA256(document URL + BEK/CK), not a hash of an API URL.
// Never accept a client-selected page URL/hash as an API request hash. A fresh,
// signed challenge fixes the page URL, login session, config and expiration.
// This is SEB's key protocol, NOT hardware attestation or continuous monitoring.
export const SEB_CHALLENGE_PARAM = '_seb_challenge';
export const SEB_CHALLENGE_TTL_SECONDS = 180;
export const SEB_ACCESS_TTL_SECONDS = 1800;
export type SebIdentity = { id: string; sessionId?: string };
type Claims = jwt.JwtPayload & { purpose: string; userId: string; sessionId: string; config: string; path?: string };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hashMatches = (value: unknown, expected: string) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'));

export const sebJsApiEnabled = (env: NodeJS.ProcessEnv = process.env) => env.EXAM_SEB_JS_API_ENABLED === 'true';
// Rotation of either the approved file or accepted keys invalidates access proofs.
const configFingerprint = (env: NodeJS.ProcessEnv) => sha(JSON.stringify([env.EXAM_SEB_CONFIG_FILE_SHA256, sebKeys(env)]));
const enabled = (env: NodeJS.ProcessEnv) => sebJsApiEnabled(env) && examEnvStatus(env).ready && sebKeys(env).browserExam.length > 0 && !!env.JWT_SECRET;

function examPage(path: unknown, origin: string): URL | null {
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/provider-overview/') || /[\\\r\n#]/.test(path)) return null;
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/provider-overview/')) return null;
    url.searchParams.delete(SEB_CHALLENGE_PARAM);
    return url;
  } catch { return null; }
}

function readClaims(token: unknown, purpose: string, user: SebIdentity, env: NodeJS.ProcessEnv): Claims | null {
  if (!enabled(env) || !user.sessionId || typeof token !== 'string' || token.length > 8192) return null;
  try {
    const p = jwt.verify(token, examSigningSecret(env, 'seb-js-v1'), { algorithms: ['HS256'] }) as Claims;
    if (p.purpose !== purpose || p.userId !== user.id || p.sessionId !== user.sessionId || p.config !== configFingerprint(env) || !p.jti || !Number.isSafeInteger(p.exp)) return null;
    return p;
  } catch { return null; }
}

export function issueSebJsChallenge(user: SebIdentity, path: unknown, env: NodeJS.ProcessEnv = process.env): { url: string; expiresAt: string } | null {
  const origin = examPublicOrigin(env);
  if (!enabled(env) || !user.sessionId || !origin) return null;
  const url = examPage(path, origin); if (!url) return null;
  const token = jwt.sign({ purpose: 'SEB_CHALLENGE', userId: user.id, sessionId: user.sessionId, config: configFingerprint(env), path: url.pathname + url.search }, examSigningSecret(env, 'seb-js-v1'), { algorithm: 'HS256', expiresIn: SEB_CHALLENGE_TTL_SECONDS, jwtid: randomUUID() });
  url.searchParams.set(SEB_CHALLENGE_PARAM, token);
  return { url: url.href, expiresAt: new Date(Date.now() + SEB_CHALLENGE_TTL_SECONDS * 1000).toISOString() };
}

export async function exchangeSebJsChallenge(user: SebIdentity, input: { challenge?: unknown; browserExamKeyHash?: unknown; configKeyHash?: unknown }, env: NodeJS.ProcessEnv = process.env, store: TicketUseStore = durableExamTicketUses): Promise<{ proof: string; expiresAt: string } | null> {
  const p = readClaims(input.challenge, 'SEB_CHALLENGE', user, env);
  const origin = examPublicOrigin(env);
  if (!p || !origin) return null;
  const url = examPage(p.path, origin); if (!url) return null;
  url.searchParams.set(SEB_CHALLENGE_PARAM, input.challenge as string);
  const keys = sebKeys(env);
  // BEK is mandatory for the JS path; the downloadable config alone must not be
  // enough to manufacture this proof. Check CK as well when it is configured.
  if (!keys.browserExam.some(k => hashMatches(input.browserExamKeyHash, sha(url.href + k)))) return null;
  if (keys.config.length && !keys.config.some(k => hashMatches(input.configKeyHash, sha(url.href + k)))) return null;
  try {
    // Shared across workers, no process-memory fallback and no new table.
    if (!await store.claim(p.jti!, user.id, user.sessionId!, 'SEB_JS_CHALLENGE', new Date(p.exp! * 1000))) return null;
  } catch { return null; }
  const proof = jwt.sign({ purpose: 'SEB_ACCESS', userId: user.id, sessionId: user.sessionId, config: p.config }, examSigningSecret(env, 'seb-js-v1'), { algorithm: 'HS256', expiresIn: SEB_ACCESS_TTL_SECONDS, jwtid: randomUUID() });
  return { proof, expiresAt: new Date(Date.now() + SEB_ACCESS_TTL_SECONDS * 1000).toISOString() };
}

export function verifySebAccessProof(proof: unknown, user: SebIdentity | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!user && !!readClaims(proof, 'SEB_ACCESS', user, env);
}
