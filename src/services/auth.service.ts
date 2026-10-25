import { presentedIdentity } from '../utils/admin-identity';
import { systemSettingsService } from './system-settings.service';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { OtpType, UserStatus, UserRole, ReferralStatus, AccountType, User as PrismaUser } from '@prisma/client';
import { authRepository } from '../repositories/auth.repository';
import { RegisterInput, VerifyOtpInput, LoginInput, GoogleAuthInput, ForgotPasswordInput, VerifyResetCodeInput, ResetPasswordInput, VerifyLoginOtpInput } from '../routes/auth/auth.schema';
import { OAuth2Client } from 'google-auth-library';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
import { AppError } from '../utils/app-error';
import { normalizePhone } from '../utils/phone-countries';
import { logger } from '../config/logger';
import { notificationService } from './notification.service';
import { prisma } from '../config/db';
import { sessionService, SessionContext } from './session.service';
import { accountAuditLogService } from './account-logs.service';
import { initializeRoleState } from './account-management.service';
import { resolveActiveRoleDisplayFields } from '../utils/role-display-resolver';
import { otpSendThrottle, otpThrottleMessage, resendAvailableAtIso, canReuseOtp } from '../utils/otp-send-throttle';
import { withKeyLock } from '../utils/key-lock';
import { remainingMinutes } from '../utils/otp-validity';
import { OtpPurpose, OTP_MAX_ATTEMPTS, OTP_LOCKED_MESSAGE } from '../utils/otp-purpose';
import { normalizeReferralIdentifier } from '../utils/referral-identifier';
import { RESEND_GENERIC_MESSAGE, ACTIVATION_CODE_REJECTED_MESSAGE } from '../utils/auth-messages';
import { marketerNotifications } from './marketer-notifications.service';

/**
 * Phase 3C: resolves firstName/lastName for an auth response from the user's
 * CURRENTLY ACTIVE role profile (falling back to the legacy User columns when
 * the role-specific value/profile is missing), instead of always returning
 * User.firstName/lastName regardless of which role is active. Only these two
 * fields are touched — login/register responses don't expose avatarUrl or the
 * progression fields today, so this intentionally doesn't add new response
 * fields, only fixes the existing ones.
 */
function resolveAuthDisplayName(
  user: { activeRole: import('@prisma/client').UserRole; firstName: string; lastName: string },
  roleRelations: {
    clientProfile?: { firstName: string | null; lastName: string | null } | null;
    providerProfile?: { firstName: string | null; lastName: string | null } | null;
    affiliateProfile?: { firstName: string | null; lastName: string | null } | null;
  }
) {
  const legacy = {
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: null,
    profileCompletionPercent: 0,
    currentLevel: '',
    currentPoints: 0,
    pointsToNextLevel: 0
  };
  const resolved = resolveActiveRoleDisplayFields({
    activeRole: user.activeRole,
    legacy,
    clientProfile: roleRelations.clientProfile as any,
    providerProfile: roleRelations.providerProfile as any,
    affiliateProfile: roleRelations.affiliateProfile as any
  });
  return { firstName: resolved.firstName, lastName: resolved.lastName };
}

const RESET_OTP_MAX_ATTEMPTS = OTP_MAX_ATTEMPTS;
const RESET_OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
// Cost-12 bcrypt hash of a throwaway string (same cost as real account hashes): login compares against it when the email is unknown.
const DUMMY_PASSWORD_HASH = '$2b$12$3NFzRulyRz.SFCUL780vDOKcvrKnKyzfJ0HLIldoSkdFk5qbe3EvS';
const RESET_GENERIC_MESSAGE = 'إذا كان البريد الإلكتروني مسجلاً لدينا، فسيتم إرسال رمز إعادة تعيين كلمة المرور إليه';
const RESET_INVALID_CODE_MESSAGE = 'رمز التحقق غير صحيح أو منتهي الصلاحية';

// Activation codes live 10 minutes (the email says 10): a late email must not carry an already-dead code.
const EMAIL_OTP_EXPIRY_MS = 10 * 60 * 1000;
const GOOGLE_TOKEN_INVALID_MESSAGE = 'تعذر التحقق من حساب جوجل، حاول تسجيل الدخول مرة أخرى';

export interface ReferralAttributionContext {
	// Explicit affiliate selection made at registration time — either a
	// manually-typed referral code/slug, or the value picked via the
	// search-autocomplete (GET /api/affiliates/search). Both are just the
	// affiliate's AffiliateProfile.referralSlug string; a bare affiliate
	// `id` (UUID) is also accepted as a fallback, in case someone shares
	// that instead of the slug.
	affiliateIdentifier?: string;
	// The waseet_ref_code cookie set by ref.controller.ts::handleReferralClick()
	// when this user earlier followed an affiliate's /ref/:slug link.
	refCookieSlug?: string;
	// The waseet_ref_src cookie (a SourceChannel value) set together with the slug cookie; recorded on Referral.sourceChannel.
	refCookieSource?: string;
}

const SOURCE_CHANNELS = ['TIKTOK', 'X_TWITTER', 'INSTAGRAM', 'LINKEDIN', 'OTHER'] as const;
function isSourceChannel(v: string | undefined): v is (typeof SOURCE_CHANNELS)[number] {
	return !!v && (SOURCE_CHANNELS as readonly string[]).includes(v);
}

/** a***@example.com for operator logs (kept here: several tests replace notification.service wholesale). */
const maskEmail = (email: string): string => `${String(email).split('@')[0].slice(0, 1)}***@${String(email).split('@')[1] ?? ''}`;

export class AuthService {
	private async verifyGoogleIdentity(idToken: string) {
		let ticket;
		try {
			ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
		} catch {
			// A malformed / expired / wrong-audience token is the caller's problem, not a server error. Never log the token or the
			// library's error text (it can echo parts of the token), and never return provider details.
			logger.warn('[Auth] Google ID token verification failed.');
			throw new AppError(GOOGLE_TOKEN_INVALID_MESSAGE, 401);
		}
		const payload = ticket.getPayload();
		if (!payload?.sub || !payload.email || !payload.email_verified) {
			throw new AppError('تعذر التحقق من حساب جوجل', 401);
		}
		return payload;
	}

	/**
	 * Referral attribution (Marketing Affiliate/referral system, P-LG-012).
	 * Shared by BOTH the email/password registration path and the Google
	 * sign-up path (which — see googleAuth() below — actually funnels through
	 * this same registerUser()/createUserWithProfile() flow rather than
	 * creating a user anywhere else), so the two can never diverge.
	 *
	 * Resolution order (First-Touch, per P-LG-012: "أول وسيط موثق... يمتلك
	 * هذه العلاقة بشكل دائم" — the referral-link cookie represents a
	 * genuinely earlier touchpoint than a same-session manual entry, and a
	 * valid cookie attribution must never be overridden by manual input):
	 *   1. `refCookieSlug` (the waseet_ref_code cookie from an earlier
	 *      /ref/:slug click) — looked up by AffiliateProfile.referralSlug or
	 *      raw `id`. If it resolves to a real affiliate that also passes the
	 *      self-referral guard below, that affiliate is used UNCONDITIONALLY
	 *      — `affiliateIdentifier` is not even consulted.
	 *   2. Else (no cookie, or the cookie is stale/invalid/deleted/
	 *      self-referring) — fall back to `affiliateIdentifier` (explicit,
	 *      registration-time entry or search-autocomplete selection), same
	 *      lookup + guard.
	 *   3. Else no attribution.
	 *
	 * An invalid/unknown code — on EITHER path — NEVER blocks registration;
	 * attribution is silently skipped and falls through to the next step (or
	 * to no attribution). A resolved self-referral (affiliate.userId ===
	 * newUserId) is also skipped on either path — defense-in-depth only,
	 * since the registering user has no id yet at the moment they'd pick a
	 * code, so this can't happen via the normal UI today, but guards any
	 * future reuse of this function.
	 *
	 * The Referral row is created via a GUARDED insert relying on
	 * Referral.referredUserId's own @unique DB constraint: a P2002 here means
	 * this user was already attributed (a retried/duplicate call), and is
	 * treated as an already-processed no-op, never a fatal registration
	 * error, never a silent overwrite of the existing (first) attribution.
	 */
	private async resolveReferralAttribution(newUserId: string, context: ReferralAttributionContext = {}): Promise<void> {
		const findValidAffiliate = async (rawSlugOrId: string) => {
			const slugOrId = normalizeReferralIdentifier(rawSlugOrId);
			if (!slugOrId) return null;
			// Only an ACTIVE affiliate can be credited: a suspended/inactive one is ignored (no Referral row), whether it came
			// from the cookie or the typed identifier.
			const active = { user: { status: UserStatus.ACTIVE } };
			let affiliate = await prisma.affiliateProfile.findFirst({
				where: { OR: [{ referralSlug: slugOrId }, { id: slugOrId }], ...active },
				select: { id: true, userId: true }
			});
			// A typed code may differ from the stored slug only by letter case: retry once, case-insensitively.
			if (!affiliate) {
				affiliate = await prisma.affiliateProfile.findFirst({
					where: { OR: [{ referralSlug: { equals: slugOrId, mode: 'insensitive' } }, { id: slugOrId }], ...active },
					select: { id: true, userId: true }
				});
			}
			if (!affiliate || affiliate.userId === newUserId) return null;
			return affiliate;
		};

		let affiliate: { id: string; userId: string } | null = null;
		let viaCookie = false;

		const cookieSlug = context.refCookieSlug?.trim();
		if (cookieSlug) {
			affiliate = await findValidAffiliate(cookieSlug);
			viaCookie = !!affiliate;
		}

		if (!affiliate) {
			const explicitSlugOrId = context.affiliateIdentifier?.trim();
			if (!explicitSlugOrId) return;
			affiliate = await findValidAffiliate(explicitSlugOrId);
		}

		if (!affiliate) {
			logger.info('[Referral] not attributed: code did not resolve to an active marketer');
			return;
		}

		try {
			const referral = await prisma.referral.create({
				data: {
					affiliateId: affiliate.id,
					referredUserId: newUserId,
					status: ReferralStatus.PENDING,
					// the channel is only known when the visitor arrived through a tracked link (cookie); a typed code stays OTHER
					...(viaCookie && isSourceChannel(context.refCookieSource) ? { sourceChannel: context.refCookieSource } : {})
				}
			});
			// Conversion of a click into a sign-up: the marketer is told (first name only, never e-mail / phone).
			const referred = await prisma.user.findUnique({ where: { id: newUserId }, select: { firstName: true } }).catch(() => null);
			await marketerNotifications.referralJoined({ affiliateId: affiliate.id, referralId: referral.id, referredName: referred?.firstName });
		} catch (error: any) {
			if (error?.code === 'P2002') return;
			// The account already exists at this point: a failed attribution write is logged, never turned into a failed signup.
			logger.warn(`[Referral] attribution write failed (code=${error?.code ?? 'unknown'}); registration continues`);
		}
	}

	/**
	 * Register a new user
	 */
	/** Setting `registrationOpen`: the SERVER refuses new accounts while it is off (hiding the button is only the courtesy on top). Read-failure = open (a settings outage must not stop sign-ups silently either way: default is open). */
	private async assertRegistrationOpen(): Promise<void> {
		if (!(await systemSettingsService.get<boolean>('registrationOpen'))) throw new AppError('التسجيل بحسابات جديدة مغلق مؤقتًا. يمكنك المحاولة لاحقًا.', 403, undefined, 'REGISTRATION_CLOSED');
	}

	public async registerUser(rawInput: RegisterInput, referralContext: Pick<ReferralAttributionContext, 'refCookieSlug' | 'refCookieSource'> = {}) {
		await this.assertRegistrationOpen();
		// validateRequest only validates (it does not replace req.body with the parsed value), so the address is normalised here, where it is stored.
		const input: RegisterInput = { ...rawInput, email: String(rawInput.email ?? '').trim().toLowerCase() };
		const googleIdentity = input.googleIdToken ? await this.verifyGoogleIdentity(input.googleIdToken) : undefined;
		if (googleIdentity && googleIdentity.email?.trim().toLowerCase() !== input.email) {
			throw new AppError('البريد الإلكتروني لا يطابق حساب جوجل المختار', 400);
		}
		// The phone is the pair (country code, LOCAL number) and must be a real mobile number OF THAT COUNTRY (an Egyptian number never goes with +966);
		// it is stored as the code in phoneCountryCode and the local digits (no code, no trunk zero) in phoneNumber.
		try {
			const phone = normalizePhone(input.phoneNumber, input.phoneCountryCode);
			input.phoneNumber = phone.nationalNumber;
			input.phoneCountryCode = phone.countryCode;
		} catch {
			throw new AppError('رقم الجوال غير صالح أو لا يطابق رمز الدولة المختار', 400);
		}
		// A missing password is a plain input error: answered the same whether or not the address / phone is in use.
		if (!input.password && !googleIdentity) throw new AppError('كلمة المرور مطلوبة', 400);
		// 1. Check for duplicates (email or phone)
		const existingUser = await authRepository.findByEmailOrPhone(input.email, input.phoneNumber);
		if (existingUser) {
			// Only a VERIFIED Google credential for this very address proves the caller controls it: that caller may be told the account exists.
			if (googleIdentity && existingUser.email.trim().toLowerCase() === input.email) {
				throw new AppError('هذا الحساب موجود بالفعل، يرجى تسجيل الدخول', 409);
			}
			// Anyone else (an arbitrary email / phone typed into the form): nothing is created, no code is created or sent (active or pending
			// alike, no alert mail either). The CONTROLLER answers every outcome with one identical public body (no id, no flags), so this
			// internal result is never visible to the caller. A pending owner gets a code through "resend" (by e-mail, throttled) or login; an
			// active one logs in or recovers the password. The same bcrypt cost keeps the response time close.
			if (input.password) await bcrypt.hash(input.password, 12);
			// operator-only: the PUBLIC answer is identical, so this line is the only place that tells support why no code arrived (never the code, the address is masked)
			logger.info(`[Register] outcome=in-use-nothing-created to=${maskEmail(input.email)} (email or phone already belongs to an account; no code, no mail)`);
			return { userId: null as string | null, accountCreated: false };
		}

		// 2. Hash Password
		const saltRounds = 12;
		const hashedPassword = input.password ? await bcrypt.hash(input.password, saltRounds) : null;

		// 3. Create User & Profile via Repository Transaction
		const user = await authRepository.createUserWithProfile(input, hashedPassword, googleIdentity);

		// 3b. Referral attribution (P-LG-012) — deliberately its OWN small step
		// AFTER createUserWithProfile()'s transaction has already committed,
		// rather than folded into it: attribution success/failure must never
		// roll back account creation, and an invalid/unknown code must never
		// fail registration (see resolveReferralAttribution()'s own doc
		// comment for the full precedence/guard rules). Covers BOTH the plain
		// email/password path and the Google sign-up path — a Google sign-up
		// also arrives here (with googleIdentity set above) since there is no
		// separate user-creation call site for it (see googleAuth() below).
		// A marketing broker (affiliate) is never referred by another affiliate: the referral cookie, the explicit
		// affiliateIdentifier and any other referral source are ignored for that account type (email and Google sign-up
		// both come through here). Clients and providers are attributed as before.
		if (input.accountType !== AccountType.MARKETING_BROKER) {
			await this.resolveReferralAttribution(user.id, {
				affiliateIdentifier: input.affiliateIdentifier,
				refCookieSlug: referralContext.refCookieSlug,
				refCookieSource: referralContext.refCookieSource
			});
		}

		// 4. Generate a 6-digit OTP (valid 10 minutes, as the email says) and store it
		const otpCode = crypto.randomInt(100000, 999999).toString();
		const expiresAt = new Date(Date.now() + EMAIL_OTP_EXPIRY_MS);
		await authRepository.createOtp(user.id, otpCode, OtpType.EMAIL, expiresAt, OtpPurpose.ACTIVATION);
		if (process.env.NODE_ENV === 'development') {
			console.log(`\n======================================================\n🔑 [LOCAL DEV ACTIVATION OTP] Email: ${user.email} -> CODE: ${otpCode}\n======================================================\n`);
		}

		// 5. Send it WITHOUT waiting for SMTP: the public answer is identical for a new and an in-use address, and an SMTP round-trip
		//    would make a new registration measurably slower than an in-use one. A failed send is logged by sendActivationEmail (never the
		//    code); the user then uses "resend code" on the code step (generic, throttled).
		void this.sendActivationEmail(user.email, otpCode, 'register');
		logger.info(`[Register] outcome=created to=${maskEmail(user.email)} activation mail queued`);

		return {
			userId: user.id as string | null,
			accountCreated: true
		};
	}

	/**
	 * Sends an activation code and reports whether the SMTP server accepted it. Never throws: a failure is logged with the
	 * server response by notificationService (never the code) and returned as `false`.
	 */
	private async sendActivationEmail(email: string, code: string, flow: string, validityMinutes: number = 10): Promise<boolean> {
		try {
			await notificationService.sendEmailOtp(email, code, validityMinutes);
			return true;
		} catch {
			logger.error(`[Auth] Activation email was NOT delivered (flow=${flow}).`);
			return false;
		}
	}

	/**
	 * Resend OTP
	 */
	public async resendOtp(userId: string): Promise<{ emailSent: boolean; reused: boolean }> {
		const user = await authRepository.findById(userId);
		// Unknown id and already-active account are answered exactly like a send (the endpoint is unauthenticated): nothing is sent or created.
		if (!user || user.status === UserStatus.ACTIVE) {
			return { emailSent: true, reused: false };
		}
		const { otpCode, reused, validityMinutes } = await this.prepareActivationCode(user.id);
		if (!reused && process.env.NODE_ENV === 'development') {
			console.log(`\n======================================================\n🔑 [LOCAL DEV ACTIVATION OTP] Email: ${user.email} -> CODE: ${otpCode}\n======================================================\n`);
		}
		const emailSent = await this.sendActivationEmail(user.email, otpCode, reused ? 'resend-same-code' : 'resend-new-code', validityMinutes);
		return { emailSent, reused };
	}

	/**
	 * Resend by the e-mail typed at registration (the public register answer carries no account id). Sends only when an account with that
	 * address is still waiting for activation; every other case (unknown, active, suspended) does nothing. The caller always gets the same
	 * answer; the SMTP result is not awaited (equal timing) and a failure is only logged.
	 */
	public async resendOtpByEmail(email: string): Promise<void> {
		const user = await authRepository.findByEmail(email);
		if (!user || user.status !== UserStatus.PENDING_VERIFICATION) return;
		const { otpCode, reused, validityMinutes } = await this.prepareActivationCode(user.id);
		void this.sendActivationEmail(user.email, otpCode, reused ? 'resend-same-code' : 'resend-new-code', validityMinutes);
	}

	/**
	 * A code that is still valid is RE-SENT as it is (not replaced): an older email that arrives late must not carry a
	 * dead code. A new one is created only when there is none or the last one has expired.
	 */
	private async prepareActivationCode(userId: string): Promise<{ otpCode: string; reused: boolean; validityMinutes: number }> {
		const existing = await authRepository.findLatestActivationOtp(userId);
		if (canReuseOtp(existing, OTP_MAX_ATTEMPTS)) {
			return { otpCode: existing!.code, reused: true, validityMinutes: remainingMinutes(existing!.expiresAt) };
		}
		const otpCode = crypto.randomInt(100000, 999999).toString();
		await authRepository.deleteActivationOtps(userId);
		await authRepository.createOtp(userId, otpCode, OtpType.EMAIL, new Date(Date.now() + EMAIL_OTP_EXPIRY_MS), OtpPurpose.ACTIVATION);
		return { otpCode, reused: false, validityMinutes: 10 };
	}

	/**
	 * Request a password-reset code by email.
	 * Always resolves to the same generic message regardless of whether the
	 * email is registered, so the endpoint can't be used to enumerate accounts.
	 */
	public async forgotPassword(input: ForgotPasswordInput) {
		const user = await authRepository.findByEmail(input.email);

		// Unknown email: silently no-op but still return the generic success
		// message, so the endpoint can't be used to enumerate accounts.
		//
		// A Google/OAuth-only account (user.password is null) is intentionally
		// NOT skipped here — resetPassword() sets/overwrites the password field
		// regardless of authProvider, letting these accounts gain a local
		// password via the same OTP flow. This never touches authProvider or
		// googleId, so Google login keeps working unchanged afterwards.
		// `expiresAt` has the same shape for a known and an unknown address (the unknown one is the time a fresh code WOULD stop being valid).
		if (!user) {
			return { message: RESET_GENERIC_MESSAGE, expiresAt: new Date(Date.now() + RESET_OTP_EXPIRY_MS).toISOString() };
		}

		// A reset code that is still valid (not locked by wrong attempts, and with enough validity left for the mail to arrive) is re-sent as it is,
		// not replaced; one request at a time per account so simultaneous requests cannot delete each other's code.
		const { otpCode, resetExpiresAt } = await withKeyLock(`reset:${user.id}`, async () => {
			const existingReset = await authRepository.findLatestPasswordResetOtp(user.id);
			if (canReuseOtp(existingReset, RESET_OTP_MAX_ATTEMPTS)) {
				return { otpCode: existingReset!.code, resetExpiresAt: existingReset!.expiresAt };
			}
			const fresh = crypto.randomInt(100000, 999999).toString();
			const freshExpiry = new Date(Date.now() + RESET_OTP_EXPIRY_MS);
			await authRepository.deletePasswordResetOtps(user.id);
			await authRepository.createPasswordResetOtp(user.id, fresh, freshExpiry);
			return { otpCode: fresh, resetExpiresAt: freshExpiry };
		});

		// Not awaited: the SMTP round-trip would make a registered address answer measurably slower than an unknown one. The failure
		// (with the SMTP response) is logged by notificationService; the answer stays generic either way.
		void Promise.resolve()
			.then(() => notificationService.sendPasswordResetEmail(user.email, user.firstName, otpCode, remainingMinutes(resetExpiresAt)))
			.catch(() => { logger.error('[Auth] Password reset email was NOT delivered.'); });

		return { message: RESET_GENERIC_MESSAGE, expiresAt: resetExpiresAt.toISOString() };
	}

	/**
	 * Validate a password-reset code without consuming it.
	 * Used by the frontend to move from the code step to the new-password step.
	 */
	public async verifyResetCode(input: VerifyResetCodeInput) {
		await this.checkResetOtp(input.email, input.code);
		return { valid: true };
	}

	/**
	 * Complete the reset: re-validate the code, then set the new password.
	 */
	public async resetPassword(input: ResetPasswordInput) {
		const { user, otp } = await this.checkResetOtp(input.email, input.code);

		const hashedPassword = await bcrypt.hash(input.newPassword, 12);
		await authRepository.updatePassword(user.id, hashedPassword);
		await authRepository.deletePasswordResetOtps(user.id);
		// every existing session (any device, including a thief's) ends when the password is reset (AUD-FND-000034)
		await sessionService.revokeAll(user.id, 'PASSWORD_RESET');

		return { message: 'تم تغيير كلمة المرور بنجاح' };
	}

	/**
	 * Shared lookup/validation for the reset OTP, used by both verifyResetCode
	 * and resetPassword so the code is always re-checked server-side (never
	 * trusted from earlier client state), and can never be confused with an
	 * activation OTP since it is looked up by its PASSWORD_RESET context.
	 */
	private async checkResetOtp(email: string, code: string) {
		const user = await authRepository.findByEmail(email);
		if (!user) {
			throw new AppError(RESET_INVALID_CODE_MESSAGE, 400);
		}

		const otp = await authRepository.findLatestPasswordResetOtp(user.id);
		if (!otp) {
			throw new AppError(RESET_INVALID_CODE_MESSAGE, 400);
		}

		if (otp.attempts >= RESET_OTP_MAX_ATTEMPTS) {
			await authRepository.deletePasswordResetOtps(user.id);
			throw new AppError(OTP_LOCKED_MESSAGE, 429);
		}

		if (otp.expiresAt < new Date()) {
			// same words as a wrong code: an expired answer would tell an unauthenticated caller that a reset was requested for this email
			throw new AppError(RESET_INVALID_CODE_MESSAGE, 400);
		}

		if (otp.code !== code) {
			await authRepository.incrementOtpAttempts(otp.id);
			// the fifth wrong guess deletes the code at once (a new one must be requested)
			if (otp.attempts + 1 >= RESET_OTP_MAX_ATTEMPTS) {
				await authRepository.deletePasswordResetOtps(user.id);
				throw new AppError(OTP_LOCKED_MESSAGE, 429);
			}
			throw new AppError(RESET_INVALID_CODE_MESSAGE, 400);
		}

		return { user, otp };
	}

	/**
	 * Verify OTP and issue JWT
	 */
	public async verifyOtp(input: VerifyOtpInput, sessionContext: SessionContext = {}) {
		// By e-mail (the public registration step) every failure is ONE answer with one status: unknown address, active / blocked account,
		// no code, expired, wrong, locked. By id (login-while-pending, after the password check) the specific messages are kept.
		const byEmail = !input.userId;
		const fail = (specific: AppError): never => { throw byEmail ? new AppError(ACTIVATION_CODE_REJECTED_MESSAGE, 400) : specific; };
		let userId = input.userId as string;
		if (byEmail) {
			const account = await authRepository.findByEmail(input.email as string);
			if (!account || account.status !== UserStatus.PENDING_VERIFICATION) return fail(new AppError('', 400));
			userId = account.id;
		}

		// 1. Fetch the latest ACTIVATION code only: a code issued for another purpose (password reset, sensitive change, checkout,
		//    contract signature) or a legacy purpose-less one is never accepted here (AUD-FND-000031). An unknown user and a wrong
		//    code share the same answer, so the endpoint cannot be used to find out which accounts exist.
		const otp = await authRepository.findLatestActivationOtp(userId);

		if (!otp) {
			return fail(new AppError('رمز التحقق غير صحيح', 400));
		}

		if (otp.attempts >= OTP_MAX_ATTEMPTS) {
			await authRepository.deleteActivationOtps(userId);
			return fail(new AppError(OTP_LOCKED_MESSAGE, 429));
		}

		// 2. Check Expiration
		if (otp.expiresAt < new Date()) {
			return fail(new AppError('رمز التحقق انتهت صلاحيته، يرجى إعادة الإرسال', 400));
		}

		// 3. Compare; every wrong guess counts and the fifth deletes the code (AUD-FND-000030)
		if (otp.code !== input.code) {
			await authRepository.incrementOtpAttempts(otp.id);
			if (otp.attempts + 1 >= OTP_MAX_ATTEMPTS) {
				await authRepository.deleteActivationOtps(userId);
				return fail(new AppError(OTP_LOCKED_MESSAGE, 429));
			}
			return fail(new AppError('رمز التحقق غير صحيح', 400));
		}

		// 3. Mark user as ACTIVE and delete OTPs
		const updatedUser = await authRepository.updateUserStatus(userId, UserStatus.ACTIVE);
		await authRepository.deleteUserOtps(userId);

		// If user is a MARKETING_BROKER, ensure their AffiliateProfile exists.
		// This is normally a dead branch — registration already creates it via
		// createMissingRoleProfiles (getInitialRolesForAccountType includes
		// AFFILIATE for MARKETING_BROKER) — but kept as a defensive fallback for
		// an older/partial signup. Phase 3D.4: routed through the same
		// canonical initializer (own existence check, seeded display fields,
		// real initial completion) instead of a bare divergent create, so it
		// can never again produce a row shaped differently from every other
		// creation path. updatedUser already carries every scalar field
		// (a bare prisma.user.update() result, no select), so it can be passed
		// directly as the identity.
		if (updatedUser.accountType === 'MARKETING_BROKER') {
			await prisma.$transaction(async (tx) => {
				await initializeRoleState(tx, updatedUser.id, UserRole.AFFILIATE, updatedUser);
			});
		}

		// 4. Generate JWT Access Token
		const jwtSecret = process.env.JWT_SECRET;
		if (!jwtSecret) {
			throw new AppError('خطأ في إعدادات الخادم: مفتاح التشفير JWT_SECRET غير معرّف', 500);
		}
		const token = jwt.sign(
			{
				userId: updatedUser.id,
				accountType: updatedUser.accountType
			},
			jwtSecret,
			{ expiresIn: '7d' }
		);
		await sessionService.register(updatedUser.id, token, sessionContext);

		// 5. Return safe user data + token
		return {
			token,
			user: {
				id: updatedUser.id,
				firstName: updatedUser.firstName,
				lastName: updatedUser.lastName,
				email: updatedUser.email,
				accountType: updatedUser.accountType,
				...presentedIdentity(updatedUser)
			}
		};
	}

	/**
	 * Login User
	 */
	/**
	 * Login (password or Google) for an account that is not verified yet: send the activation code, subject to the OTP send
	 * limits (per account and per IP, apart from the login limiter). The answer says whether the email really went out, and
	 * when the send was throttled it says how long to wait (the previous code is still valid, so the user can use it).
	 */
	private async pendingVerificationResult(userId: string, ipAddress: string | undefined) {
		const throttle = otpSendThrottle.consume(`user:${userId}`, ipAddress);
		if (!throttle.allowed) {
			return {
				verified: false as const,
				phoneOtpRequired: false,
				userId,
				emailSent: false,
				retryAfterSeconds: throttle.retryAfterSeconds,
				message: otpThrottleMessage(throttle.reason!, throttle.retryAfterSeconds)
			};
		}
		const { emailSent } = await this.resendOtp(userId);
		return {
			verified: false as const,
			phoneOtpRequired: false,
			userId,
			emailSent,
			...(emailSent ? { resendAvailableAt: resendAvailableAtIso() } : {}),
			message: emailSent ? 'يرجى تفعيل حسابك أولاً' : 'يرجى تفعيل حسابك أولاً. تعذر إرسال رمز التحقق الآن، حاول مرة أخرى بعد قليل أو تواصل مع الدعم'
		};
	}

	public async loginUser(input: LoginInput, sessionContext: SessionContext = {}) {
		const user = await authRepository.findByEmail(input.email);

		if (!user || !user.password) {
			// Same bcrypt cost as a real check, so "no such account" cannot be told from "wrong password" by response time.
			await bcrypt.compare(input.password, DUMMY_PASSWORD_HASH);
			throw new AppError('البريد الإلكتروني أو كلمة المرور غير صحيحة', 401);
		}

		const isMatch = await bcrypt.compare(input.password, user.password);

		if (!isMatch) {
			await accountAuditLogService.record({ userId: user.id, eventType: 'LOGIN_REJECTED', category: 'SECURITY_CHANGE', title: 'محاولة تسجيل دخول مرفوضة', summary: 'تم رفض محاولة تسجيل دخول بكلمة مرور غير صحيحة', source: 'USER', severity: 'WARNING', status: 'REJECTED', context: { ipAddress: sessionContext.ipAddress, device: sessionContext.userAgent?.slice(0, 120) } });
			throw new AppError('البريد الإلكتروني أو كلمة المرور غير صحيحة', 401);
		}

		if (user.status === UserStatus.PENDING_VERIFICATION) {
			return this.pendingVerificationResult(user.id, sessionContext.ipAddress);
		}

		if (user.status === UserStatus.SUSPENDED) {
			throw new AppError('هذا الحساب معطل حالياً، يرجى التواصل مع الدعم', 403);
		}

		// Email OTP is mandatory at login (owner decision #4): a correct password only starts the challenge, no token is issued here.
		// Phone/SMS is never used (`phoneOtpEnabled` is ignored). The session is created by verifyLoginOtp().
		return this.loginOtpChallengeResult(user.id, user.email, sessionContext.ipAddress);
	}

	/** Sends (or re-sends) the LOGIN_EMAIL code for an ACTIVE account; subject to the shared OTP send throttle. */
	private async loginOtpChallengeResult(userId: string, email: string, ipAddress: string | undefined) {
		const base = { verified: false as const, phoneOtpRequired: false, loginOtpRequired: true as const, userId };
		const key = `login:${userId}`;
		// One request at a time per account: two simultaneous requests (double click, two tabs) cannot create / delete the same code under each other.
		// The cooldown and the hourly allowance start only when the mail server ACCEPTED the message (peek, send, record), so a failed send is never
		// answered with "we already sent it" and failures never lock the recipient out.
		const cid = crypto.randomBytes(4).toString('hex'); // correlates the log lines of this one attempt (never the code, the e-mail address or the password)
		const startedAt = Date.now();
		return withKeyLock(key, async () => {
			// reserve: the per-IP slot is taken now (concurrent requests from one address cannot all pass while the mail is in flight); the recipient
			// cooldown / allowance start only below, when the mail server accepted the message.
			const throttle = otpSendThrottle.reserve(key, ipAddress);
			if (!throttle.allowed) {
				logger.info(`[OTP:login] cid=${cid} outcome=throttled reason=${throttle.reason} wait=${throttle.retryAfterSeconds}s ms=${Date.now() - startedAt}`);
				return { ...base, emailSent: false, retryAfterSeconds: throttle.retryAfterSeconds, message: otpThrottleMessage(throttle.reason!, throttle.retryAfterSeconds) };
			}
			const { emailSent, expiresAt, reused } = await this.sendLoginOtp(userId, email);
			otpSendThrottle.commitRecipient(key, emailSent);
			logger.info(`[OTP:login] cid=${cid} outcome=${emailSent ? 'sent' : 'send-failed'} reused=${reused} validForMs=${expiresAt.getTime() - Date.now()} ms=${Date.now() - startedAt}`);
			return { ...base, emailSent, ...(emailSent ? { resendAvailableAt: resendAvailableAtIso(), expiresAt: expiresAt.toISOString() } : {}), message: emailSent ? 'أرسلنا رمز تسجيل الدخول إلى بريدك الإلكتروني' : 'تعذر إرسال رمز تسجيل الدخول الآن، حاول مرة أخرى بعد قليل أو تواصل مع الدعم' };
		});
	}

	/** A still-valid LOGIN_EMAIL code is re-sent as it is (a late older email must not carry a dead code); otherwise a new one is created. */
	private async sendLoginOtp(userId: string, email: string): Promise<{ emailSent: boolean; reused: boolean; expiresAt: Date }> {
		// The choose-or-create step of the code shares one short critical section with verifyLoginOtp, so a verification can never delete the code a
		// resend has just created (or the other way round). The SMTP wait below is OUTSIDE it: a slow mail never blocks a verification.
		const { code, reused, expiresAt } = await withKeyLock(`login-otp-db:${userId}`, async () => {
			const existing = await authRepository.findLatestOtpByPurpose(userId, OtpPurpose.LOGIN_EMAIL);
			if (canReuseOtp(existing, OTP_MAX_ATTEMPTS)) return { code: existing!.code, reused: true, expiresAt: existing!.expiresAt };
			const fresh = crypto.randomInt(100000, 999999).toString();
			const freshExpiry = new Date(Date.now() + EMAIL_OTP_EXPIRY_MS);
			await authRepository.deleteOtpsByPurpose(userId, OtpPurpose.LOGIN_EMAIL);
			await authRepository.createOtp(userId, fresh, OtpType.EMAIL, freshExpiry, OtpPurpose.LOGIN_EMAIL);
			return { code: fresh, reused: false, expiresAt: freshExpiry };
		});
		if (process.env.NODE_ENV === 'development') {
			console.log(`\n======================================================\n🔑 [LOCAL DEV LOGIN OTP] Email: ${email} -> CODE: ${code}\n======================================================\n`);
		}
		try {
			// the mail states the REAL time left (a re-sent code keeps its original expiry), never a fresh 10 minutes
			await notificationService.sendLoginOtpEmail(email, code, remainingMinutes(expiresAt));
			return { emailSent: true, reused, expiresAt };
		} catch (error) {
			logger.error(`[AuthService] Login OTP email failed (userId=${userId})`, error);
			return { emailSent: false, reused, expiresAt };
		}
	}

	/** Creates the session (JWT + registered session row) for an account whose password AND login code were verified. */
	private async startSession(user: NonNullable<Awaited<ReturnType<typeof authRepository.findByIdForSession>>>, sessionContext: SessionContext) {
		// Generate JWT Access Token
		const jwtSecret = process.env.JWT_SECRET;
		if (!jwtSecret) {
			throw new AppError('خطأ في إعدادات الخادم: مفتاح التشفير JWT_SECRET غير معرّف', 500);
		}
		const token = jwt.sign(
			{
				userId: user.id,
				accountType: user.accountType
			},
			jwtSecret,
			{ expiresIn: '7d' }
		);
		await sessionService.register(user.id, token, sessionContext);

		const { firstName, lastName } = resolveAuthDisplayName(user, {
			clientProfile: user.clientProfile,
			providerProfile: user.providerProfile,
			affiliateProfile: user.affiliateProfile
		});

		return {
			verified: true as const,
			token,
			user: {
				id: user.id,
				firstName,
				lastName,
				email: user.email,
				accountType: user.accountType,
				...presentedIdentity(user)
			}
		};
	}

	/**
	 * Google Auth Login / Register
	 *
	 * Referral attribution note: `referralContext` is accepted here for
	 * symmetry with registerUser() (same shared resolveReferralAttribution()
	 * helper, same precedence rule), but this method's 'register' intent
	 * branch below never actually creates a user — it only verifies identity
	 * and hands back `googleProfile` for the client to then call POST
	 * /register with `googleIdToken` set, which is where the account (and any
	 * referral attribution) is actually created. There is therefore no new
	 * user id available at any point in THIS method to attribute against;
	 * `referralContext` is currently unused here for that reason, kept only
	 * so a future change that creates a user directly in this flow doesn't
	 * also need to thread a new parameter through the controller/schema.
	 */
	public async googleAuth(input: GoogleAuthInput, sessionContext: SessionContext = {}, _referralContext: Pick<ReferralAttributionContext, 'refCookieSlug'> = {}) {
		const payload = await this.verifyGoogleIdentity(input.idToken);
		const email = payload.email!.trim().toLowerCase();
		const existingUser = await authRepository.findByEmail(email);
		// Older clients identify registration by supplying an account type.
		const intent = input.intent ?? (input.accountType ? 'register' : 'login');
		if (intent === 'register') {
			await this.assertRegistrationOpen();
			if (existingUser) {
				// Reached only with a VERIFIED Google credential for this address: the caller proved they control it.
				throw new AppError('هذا الحساب موجود بالفعل، يرجى تسجيل الدخول', 409);
			}
			// Only return verified identity fields. No user, session or access token
			// is created until /register receives the completed form and consent.
			return {
				verified: false,
				registrationRequired: true,
				googleProfile: {
					email,
					firstName: payload.given_name || '',
					lastName: payload.family_name || ''
				}
			};
		}
		if (!existingUser) {
			// Verified Google credential only (see above). The way forward is the Sign-up path; a Login intent never creates an account.
			throw new AppError('لا يوجد حساب مرتبط بحساب جوجل هذا، يرجى إنشاء حساب أولاً', 404);
		}
		if (existingUser.status === UserStatus.SUSPENDED) {
			throw new AppError('هذا الحساب معطل حالياً، يرجى التواصل مع الدعم', 403);
		}
		if (existingUser.googleId && existingUser.googleId !== payload.sub) {
			// the address is the same but another Google identity is linked: not spelled out (same words as an unverifiable token)
			throw new AppError(GOOGLE_TOKEN_INVALID_MESSAGE, 401);
		}
		// Captured before any prisma.user.update() below, which returns a bare
		// scalar User (no relations) and would otherwise silently drop these.
		const roleRelations = {
			clientProfile: existingUser?.clientProfile,
			providerProfile: existingUser?.providerProfile,
			affiliateProfile: existingUser?.affiliateProfile
		};
		let user: Pick<PrismaUser, 'id' | 'email' | 'accountType' | 'activeRole' | 'roles' | 'status' | 'googleId' | 'firstName' | 'lastName' | 'phoneNumber' | 'phoneCountryCode' | 'phoneOtpEnabled'> | null = existingUser;

		if (!user.googleId) {
			user = await prisma.user.update({
				where: { id: user.id },
				data: { googleId: payload.sub, authProvider: 'google' }
			});
		}
		if (user.status === UserStatus.PENDING_VERIFICATION) {
			return this.pendingVerificationResult(user.id, sessionContext.ipAddress);
		}

		if (user.status === UserStatus.SUSPENDED) {
			throw new AppError('هذا الحساب معطل حالياً، يرجى التواصل مع الدعم', 403);
		}

		// Owner decision #4: Google proves the identity but does not create the session. The same mandatory LOGIN_EMAIL challenge as the
		// password login is started for the account email; the session comes only from POST /auth/login/verify-otp. (A brand-new Google
		// account never gets here: it is created by POST /register as PENDING_VERIFICATION and is activated by its email code.)
		return this.loginOtpChallengeResult(user.id, user.email, sessionContext.ipAddress);
	}

	/**
	 * Second step of every password login: the LOGIN_EMAIL code sent to the account email. Only a code issued for this purpose is accepted
	 * (a password-reset / activation / phone-change code never works here), 5 wrong guesses delete it, and the session is created only now.
	 */
	public async verifyLoginOtp(input: VerifyLoginOtpInput, sessionContext: SessionContext = {}) {
		// One verification at a time per account: the same right code sent twice at once (double click) opens ONE session, the second finds the code used.
		return withKeyLock(`login-otp-db:${input.userId}`, () => this.verifyLoginOtpLocked(input, sessionContext));
	}

	private async verifyLoginOtpLocked(input: VerifyLoginOtpInput, sessionContext: SessionContext) {
		const user = await authRepository.findByIdForSession(input.userId);
		const otp = user ? await authRepository.findLatestOtpByPurpose(input.userId, OtpPurpose.LOGIN_EMAIL) : null;
		if (!user || !otp) throw new AppError('رمز التحقق غير صحيح', 400);
		if (otp.attempts >= OTP_MAX_ATTEMPTS) {
			await authRepository.deleteOtpsByPurpose(input.userId, OtpPurpose.LOGIN_EMAIL);
			throw new AppError(OTP_LOCKED_MESSAGE, 429);
		}
		if (otp.expiresAt < new Date()) throw new AppError('رمز التحقق انتهت صلاحيته، يرجى إعادة الإرسال', 400);
		if (otp.code !== input.code) {
			await authRepository.incrementOtpAttempts(otp.id);
			if (otp.attempts + 1 >= OTP_MAX_ATTEMPTS) {
				await authRepository.deleteOtpsByPurpose(input.userId, OtpPurpose.LOGIN_EMAIL);
				throw new AppError(OTP_LOCKED_MESSAGE, 429);
			}
			throw new AppError('رمز التحقق غير صحيح', 400);
		}
		if (user.status === UserStatus.SUSPENDED) throw new AppError('هذا الحساب معطل حالياً، يرجى التواصل مع الدعم', 403);
		if (user.status === UserStatus.PENDING_VERIFICATION) throw new AppError('رمز التحقق غير صحيح', 400);
		await authRepository.deleteOtpsByPurpose(input.userId, OtpPurpose.LOGIN_EMAIL);
		return this.startSession(user, sessionContext);
	}

	/** Re-sends the login code (same throttle as the first send). Only an ACTIVE account that is mid-login has anything to resend. */
	public async resendLoginOtp(userId: string, ipAddress?: string) {
		const user = await authRepository.findById(userId);
		const pending = user ? await authRepository.findLatestOtpByPurpose(userId, OtpPurpose.LOGIN_EMAIL) : null;
		if (!user || user.status !== UserStatus.ACTIVE || !pending) {
			// Unauthenticated endpoint: unknown id / not mid-login looks like a real send (same throttle bucket, same shape); nothing is sent.
			const throttle = otpSendThrottle.consume(`login:${userId}`, ipAddress);
			if (!throttle.allowed) return { emailSent: false, retryAfterSeconds: throttle.retryAfterSeconds, message: otpThrottleMessage(throttle.reason!, throttle.retryAfterSeconds) };
			return { emailSent: true, resendAvailableAt: resendAvailableAtIso(), message: RESEND_GENERIC_MESSAGE };
		}
		const result = await this.loginOtpChallengeResult(userId, user.email, ipAddress);
		return { emailSent: result.emailSent, message: result.message, ...('retryAfterSeconds' in result ? { retryAfterSeconds: result.retryAfterSeconds } : {}), ...('resendAvailableAt' in result ? { resendAvailableAt: result.resendAvailableAt, expiresAt: result.expiresAt } : {}) };
	}
}

export const authService = new AuthService();
