/**
 * DEV-ONLY test accounts: a short list of e-mail addresses that may log in with the password alone (no e-mail code). Two independent switches must both be on:
 *  - SETUP_TEST_DEV_FALLBACK=true — the dev-environment flag; the official deploy never sets it (and its runbook forbids test flags);
 *  - DEV_LOGIN_OTP_BYPASS_EMAILS — a comma-separated list of exact addresses. Empty / missing = nobody.
 * The password is still checked, a suspended / unverified account is still refused, and every bypassed login is written to the account's audit trail.
 */
export function isDevLoginOtpBypassEmail(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.SETUP_TEST_DEV_FALLBACK !== 'true') return false;
	const wanted = String(email ?? '').trim().toLowerCase();
	if (!wanted) return false;
	return String(env.DEV_LOGIN_OTP_BYPASS_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean).includes(wanted);
}
