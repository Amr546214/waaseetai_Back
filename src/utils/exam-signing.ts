import { createHmac } from 'node:crypto';

/** Domain separation: an exam challenge/proof/ticket must NEVER verify as an
 * ordinary login JWT, even if an auth consumer doesn't inspect its purpose. */
export function examSigningSecret(env: NodeJS.ProcessEnv, domain: 'seb-js-v1' | 'exam-ticket-v1'): string {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET missing');
  return createHmac('sha256', env.JWT_SECRET).update(`waseet/exam/${domain}`).digest('hex');
}
