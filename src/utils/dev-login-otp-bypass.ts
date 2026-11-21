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

/** The fixed code every sensitive e-mail-code step accepts for a listed DEV test account (the same two switches as the login bypass). */
export const DEV_TEST_ACCOUNT_OTP_CODE = '000000';

/**
 * The code to store for an e-mail-code step (payment, contract signature, budget increase, PayPal e-mail change, sensitive profile change): the fixed DEV code for a listed
 * test account on dev, otherwise exactly the random code the caller generated. Verification is untouched: it compares the stored code, so a fixed code is the only
 * difference. Never changes anything on the official site (no dev flag there).
 */
export function otpCodeFor(email: string | null | undefined, generated: string, env: NodeJS.ProcessEnv = process.env): string {
	return isDevLoginOtpBypassEmail(email, env) ? DEV_TEST_ACCOUNT_OTP_CODE : generated;
}
