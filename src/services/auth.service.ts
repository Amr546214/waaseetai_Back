import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { OtpType, UserStatus, UserRole, ReferralStatus, User as PrismaUser } from '@prisma/client';
import { authRepository } from '../repositories/auth.repository';
import { RegisterInput, VerifyOtpInput, LoginInput, GoogleAuthInput, ForgotPasswordInput, VerifyResetCodeInput, ResetPasswordInput, VerifyLoginOtpInput } from '../routes/auth/auth.schema';
import { OAuth2Client } from 'google-auth-library';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { notificationService } from './notification.service';
import { prisma } from '../config/db';
import { sessionService, SessionContext } from './session.service';
import { accountAuditLogService } from './account-logs.service';
import { initializeRoleState } from './account-management.service';
import { resolveActiveRoleDisplayFields } from '../utils/role-display-resolver';
import { otpSendThrottle, otpThrottleMessage } from '../utils/otp-send-throttle';

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

const RESET_OTP_MAX_ATTEMPTS = 5;
const RESET_OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const RESET_GENERIC_MESSAGE = 'إذا كان البريد الإلكتروني مسجلاً لدينا، فسيتم إرسال رمز إعادة تعيين كلمة المرور إليه';
const RESET_INVALID_CODE_MESSAGE = 'رمز التحقق غير صحيح أو منتهي الصلاحية';

const LOGIN_OTP_MAX_ATTEMPTS = 5;
const LOGIN_OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
// Activation codes live 10 minutes (the email says 10): a late email must not carry an already-dead code.
const EMAIL_OTP_EXPIRY_MS = 10 * 60 * 1000;
const SMS_UNAVAILABLE_MESSAGE = 'التحقق عبر الرسائل النصية غير متاح حاليًا، يرجى التواصل مع الدعم لإكمال تسجيل الدخول';
const LOGIN_OTP_INVALID_MESSAGE = 'رمز التحقق غير صحيح أو منتهي الصلاحية';

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
}

export class AuthService {
	private async verifyGoogleIdentity(idToken: string) {
		const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
		const payload = ticket.getPayload();
		if (!payload?.sub || !payload.email || !payload.email_verified) {
			throw new AppError('تعذر التحقق من حساب جوجل', 401);
		}
		return payload;
	}

	/**
	 * Generate a fresh login-time PHONE OTP for a user, replacing any previous
	 * one, and dispatch it via SMS. Shared by loginUser, googleAuth and
	 * resendLoginOtp so the challenge is issued identically regardless of
	 * which login path triggered it.
	 */
	private async issuePhoneOtpChallenge(userId: string, phoneNumber: string | null, phoneCountryCode: string | null) {
		// No SMS sender exists yet: never claim a code was sent to the phone (and never create one nobody can receive).
		if (!notificationService.isSmsAvailable()) {
			logger.warn(`[Auth] Phone OTP requested for user ${userId} but SMS delivery is not available.`);
			throw new AppError(SMS_UNAVAILABLE_MESSAGE, 503);
		}

		const otpCode = crypto.randomInt(100000, 999999).toString();
		const expiresAt = new Date(Date.now() + LOGIN_OTP_EXPIRY_MS);

		await authRepository.deletePhoneOtps(userId);
		await authRepository.createOtp(userId, otpCode, OtpType.PHONE, expiresAt);

		const fullPhone = `${phoneCountryCode || ''}${phoneNumber || ''}`;
		notificationService.sendSmsOtp(fullPhone, otpCode).catch((err: any) => {
			logger.error('Failed to send login phone OTP SMS', err);
		});
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
		const findValidAffiliate = async (slugOrId: string) => {
			const affiliate = await prisma.affiliateProfile.findFirst({
				where: { OR: [{ referralSlug: slugOrId }, { id: slugOrId }] },
				select: { id: true, userId: true }
			});
			if (!affiliate || affiliate.userId === newUserId) return null;
			return affiliate;
		};

		let affiliate: { id: string; userId: string } | null = null;

		const cookieSlug = context.refCookieSlug?.trim();
		if (cookieSlug) {
			affiliate = await findValidAffiliate(cookieSlug);
		}

		if (!affiliate) {
			const explicitSlugOrId = context.affiliateIdentifier?.trim();
			if (!explicitSlugOrId) return;
			affiliate = await findValidAffiliate(explicitSlugOrId);
		}

		if (!affiliate) return;

		try {
			await prisma.referral.create({
				data: { affiliateId: affiliate.id, referredUserId: newUserId, status: ReferralStatus.PENDING }
			});
		} catch (error: any) {
			if (error?.code === 'P2002') return;
			throw error;
		}
	}

	/**
	 * Register a new user
	 */
	public async registerUser(input: RegisterInput, referralContext: Pick<ReferralAttributionContext, 'refCookieSlug'> = {}) {
		const googleIdentity = input.googleIdToken ? await this.verifyGoogleIdentity(input.googleIdToken) : undefined;
		if (googleIdentity && googleIdentity.email !== input.email) {
			throw new AppError('البريد الإلكتروني لا يطابق حساب جوجل المختار', 400);
		}
		// 1. Check for duplicates (email or phone)
		const existingUser = await authRepository.findByEmailOrPhone(input.email, input.phoneNumber);
		if (existingUser) {
			throw new AppError('البريد الإلكتروني أو رقم الجوال مسجل بالفعل، يرجى تسجيل الدخول', 409);
		}

		// 2. Hash Password
		const saltRounds = 12;
		if (!input.password && !googleIdentity) throw new AppError('كلمة المرور مطلوبة', 400);
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
		await this.resolveReferralAttribution(user.id, {
			affiliateIdentifier: input.affiliateIdentifier,
			refCookieSlug: referralContext.refCookieSlug
		});

		// 4. Generate a 6-digit OTP (valid 10 minutes, as the email says) and store it
		const otpCode = crypto.randomInt(100000, 999999).toString();
		const expiresAt = new Date(Date.now() + EMAIL_OTP_EXPIRY_MS);
		await authRepository.createOtp(user.id, otpCode, OtpType.EMAIL, expiresAt);

		// 5. Send it and WAIT for the SMTP result: the caller must be told when the email did not go out.
		const emailSent = await this.sendActivationEmail(user.email, otpCode, 'register');

		return {
			userId: user.id,
			emailSent
		};
	}

	/**
	 * Sends an activation code and reports whether the SMTP server accepted it. Never throws: a failure is logged with the
	 * server response by notificationService (never the code) and returned as `false`.
	 */
	private async sendActivationEmail(email: string, code: string, flow: string): Promise<boolean> {
		try {
			await notificationService.sendEmailOtp(email, code);
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
		if (!user) {
			throw new AppError('المستخدم غير موجود', 404);
		}
		if (user.status === UserStatus.ACTIVE) {
			throw new AppError('الحساب مفعل مسبقاً', 400);
		}

		// A code that is still valid is RE-SENT as it is (not replaced): an older email that arrives late must not carry a
		// dead code. A new one is created only when there is none or the last one has expired.
		const existing = await authRepository.findLatestActivationOtp(user.id);
		let otpCode: string;
		let reused = false;
		if (existing && existing.expiresAt > new Date()) {
			otpCode = existing.code;
			reused = true;
		} else {
			otpCode = crypto.randomInt(100000, 999999).toString();
			await authRepository.deleteActivationOtps(user.id);
			await authRepository.createOtp(user.id, otpCode, OtpType.EMAIL, new Date(Date.now() + EMAIL_OTP_EXPIRY_MS));
		}

		const emailSent = await this.sendActivationEmail(user.email, otpCode, reused ? 'resend-same-code' : 'resend-new-code');
		return { emailSent, reused };
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
		if (!user) {
			return { message: RESET_GENERIC_MESSAGE };
		}

		// A reset code that is still valid (and not locked by wrong attempts) is re-sent as it is, not replaced.
		const existingReset = await authRepository.findLatestPasswordResetOtp(user.id);
		let otpCode: string;
		if (existingReset && existingReset.expiresAt > new Date() && existingReset.attempts < RESET_OTP_MAX_ATTEMPTS) {
			otpCode = existingReset.code;
		} else {
			otpCode = crypto.randomInt(100000, 999999).toString();
			await authRepository.deletePasswordResetOtps(user.id);
			await authRepository.createPasswordResetOtp(user.id, otpCode, new Date(Date.now() + RESET_OTP_EXPIRY_MS));
		}

		try {
			await notificationService.sendPasswordResetEmail(user.email, user.firstName, otpCode);
		} catch {
			// The failure (with the SMTP response) is already logged by notificationService. The answer stays generic so the
			// endpoint cannot be used to find out which emails are registered.
			logger.error('[Auth] Password reset email was NOT delivered.');
		}

		return { message: RESET_GENERIC_MESSAGE };
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
			throw new AppError('تم تجاوز عدد المحاولات المسموح به، يرجى طلب رمز جديد', 429);
		}

		if (otp.expiresAt < new Date()) {
			throw new AppError('رمز التحقق انتهت صلاحيته، يرجى طلب رمز جديد', 400);
		}

		if (otp.code !== code) {
			await authRepository.incrementOtpAttempts(otp.id);
			throw new AppError(RESET_INVALID_CODE_MESSAGE, 400);
		}

		return { user, otp };
	}

	/**
	 * Verify OTP and issue JWT
	 */
	public async verifyOtp(input: VerifyOtpInput, sessionContext: SessionContext = {}) {
		// 1. Fetch the active OTP
		const otp = await authRepository.findValidOtp(input.userId, input.code, OtpType.EMAIL);

		if (!otp) {
			throw new AppError('رمز التحقق غير صحيح', 400);
		}

		// 2. Check Expiration
		if (otp.expiresAt < new Date()) {
			throw new AppError('رمز التحقق انتهت صلاحيته، يرجى إعادة الإرسال', 400);
		}

		// 3. Mark user as ACTIVE and delete OTPs
		const updatedUser = await authRepository.updateUserStatus(input.userId, UserStatus.ACTIVE);
		await authRepository.deleteUserOtps(input.userId);

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
				activeRole: updatedUser.activeRole,
				roles: updatedUser.roles
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
			message: emailSent ? 'يرجى تفعيل حسابك أولاً' : 'يرجى تفعيل حسابك أولاً. تعذر إرسال رمز التحقق الآن، حاول مرة أخرى بعد قليل أو تواصل مع الدعم'
		};
	}

	public async loginUser(input: LoginInput, sessionContext: SessionContext = {}) {
		const user = await authRepository.findByEmail(input.email);

		if (!user || !user.password) {
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

		if (user.phoneOtpEnabled) {
			await this.issuePhoneOtpChallenge(user.id, user.phoneNumber, user.phoneCountryCode);
			return {
				verified: false,
				phoneOtpRequired: true,
				userId: user.id,
				message: 'يرجى إدخال رمز التحقق المرسل إلى جوالك'
			};
		}

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
			verified: true,
			token,
			user: {
				id: user.id,
				firstName,
				lastName,
				email: user.email,
				accountType: user.accountType,
				activeRole: user.activeRole,
				roles: user.roles
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
		const email = payload.email!;
		const existingUser = await authRepository.findByEmail(email);
		// Older clients identify registration by supplying an account type.
		const intent = input.intent ?? (input.accountType ? 'register' : 'login');
		if (intent === 'register') {
			if (existingUser) {
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
			throw new AppError('لا يوجد حساب بهذا البريد الإلكتروني، يرجى إنشاء حساب أولاً', 404);
		}
		if (existingUser.status === UserStatus.SUSPENDED) {
			throw new AppError('هذا الحساب معطل حالياً، يرجى التواصل مع الدعم', 403);
		}
		if (existingUser.googleId && existingUser.googleId !== payload.sub) {
			throw new AppError('حساب جوجل لا يطابق الحساب المرتبط', 401);
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

		if (user.phoneOtpEnabled) {
			await this.issuePhoneOtpChallenge(user.id, user.phoneNumber, user.phoneCountryCode);
			return {
				verified: false,
				phoneOtpRequired: true,
				userId: user.id,
				message: 'يرجى إدخال رمز التحقق المرسل إلى جوالك'
			};
		}

		const jwtSecret = process.env.JWT_SECRET;
		if (!jwtSecret) throw new AppError('JWT_SECRET missing', 500);

		const token = jwt.sign(
			{ userId: user.id, accountType: user.accountType },
			jwtSecret,
			{ expiresIn: '7d' }
		);
		await sessionService.register(user.id, token, sessionContext);

		const { firstName, lastName } = resolveAuthDisplayName(user, roleRelations);

		return {
			verified: true,
			token,
			user: {
				id: user.id,
				firstName,
				lastName,
				email: user.email,
				accountType: user.accountType,
				activeRole: user.activeRole,
				roles: user.roles
			}
		};
	}

	/**
	 * Verify the login-time PHONE OTP (issued by loginUser/googleAuth when
	 * phoneOtpEnabled is set) and, on success, issue the session exactly like
	 * a normal login. Distinct from verifyOtp() above, which activates a
	 * PENDING_VERIFICATION account's EMAIL OTP and has different side effects
	 * (flips UserStatus, initializes affiliate profiles, etc.) that must never
	 * run again on an already-ACTIVE user.
	 */
	public async verifyLoginOtp(input: VerifyLoginOtpInput, sessionContext: SessionContext = {}) {
		const user = await authRepository.findByIdForSession(input.userId);
		if (!user || !user.phoneOtpEnabled || user.status !== UserStatus.ACTIVE) {
			throw new AppError(LOGIN_OTP_INVALID_MESSAGE, 400);
		}

		const otp = await authRepository.findLatestOtp(user.id, OtpType.PHONE);
		if (!otp) {
			throw new AppError(LOGIN_OTP_INVALID_MESSAGE, 400);
		}

		if (otp.attempts >= LOGIN_OTP_MAX_ATTEMPTS) {
			await authRepository.deletePhoneOtps(user.id);
			throw new AppError('تم تجاوز عدد المحاولات المسموح به، يرجى طلب رمز جديد', 429);
		}

		if (otp.expiresAt < new Date()) {
			throw new AppError('رمز التحقق انتهت صلاحيته، يرجى طلب رمز جديد', 400);
		}

		if (otp.code !== input.code) {
			await authRepository.incrementOtpAttempts(otp.id);
			throw new AppError(LOGIN_OTP_INVALID_MESSAGE, 400);
		}

		await authRepository.deletePhoneOtps(user.id);

		const jwtSecret = process.env.JWT_SECRET;
		if (!jwtSecret) {
			throw new AppError('خطأ في إعدادات الخادم: مفتاح التشفير JWT_SECRET غير معرّف', 500);
		}
		const token = jwt.sign(
			{ userId: user.id, accountType: user.accountType },
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
			verified: true,
			token,
			user: {
				id: user.id,
				firstName,
				lastName,
				email: user.email,
				accountType: user.accountType,
				activeRole: user.activeRole,
				roles: user.roles
			}
		};
	}

	/**
	 * Resend the login-time PHONE OTP. Deliberately separate from resendOtp()
	 * above, which only ever targets PENDING_VERIFICATION accounts (it errors
	 * out on an ACTIVE user) — this one requires ACTIVE + phoneOtpEnabled.
	 */
	public async resendLoginOtp(userId: string) {
		const user = await authRepository.findByIdForSession(userId);
		if (!user || !user.phoneOtpEnabled || user.status !== UserStatus.ACTIVE) {
			throw new AppError('طلب غير صالح', 400);
		}

		await this.issuePhoneOtpChallenge(user.id, user.phoneNumber, user.phoneCountryCode);
		return true;
	}
}

export const authService = new AuthService();
