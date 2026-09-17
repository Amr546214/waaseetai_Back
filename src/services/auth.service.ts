import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { OtpType, UserStatus, UserRole, User as PrismaUser } from '@prisma/client';
import { authRepository } from '../repositories/auth.repository';
import { RegisterInput, VerifyOtpInput, LoginInput, GoogleAuthInput, ForgotPasswordInput, VerifyResetCodeInput, ResetPasswordInput } from '../routes/auth/auth.schema';
import { OAuth2Client } from 'google-auth-library';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
import { AppError } from '../utils/app-error';
import { logger } from '../config/logger';
import { notificationService } from './notification.service';
import { prisma } from '../config/db';
import { sessionService, SessionContext } from './session.service';
import { accountAuditLogService } from './account-logs.service';
import { getRoleFromAccountType, getInitialRolesForAccountType, createMissingRoleProfiles, initializeRoleState } from './account-management.service';
import { resolveActiveRoleDisplayFields } from '../utils/role-display-resolver';

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

export class AuthService {
	/**
	 * Register a new user
	 */
	public async registerUser(input: RegisterInput) {
		// 1. Check for duplicates (email or phone)
		const existingUser = await authRepository.findByEmailOrPhone(input.email, input.phoneNumber);
		if (existingUser) {
			throw new AppError('البريد الإلكتروني أو رقم الجوال مسجل مسبقاً', 400);
		}

		// 2. Hash Password
		const saltRounds = 12;
		const hashedPassword = await bcrypt.hash(input.password, saltRounds);

		// 3. Create User & Profile via Repository Transaction
		const user = await authRepository.createUserWithProfile(input, hashedPassword);

		// 4. Generate 6-digit OTP
		const otpCode = crypto.randomInt(100000, 999999).toString();
		const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now

		// 5. Store OTP
		await authRepository.createOtp(user.id, otpCode, OtpType.EMAIL, expiresAt);

		// 6. Log OTP only for local testing/dev
		if (process.env.NODE_ENV === 'development') {
			logger.info(`[DEV OTP LOGGER] Verification Code for ${user.email}: ${otpCode}`);
		}

		// 7. Send actual OTP Email asynchronously
		// We don't await this so it doesn't block the HTTP response
		notificationService.sendEmailOtp(user.email, otpCode).catch((err: any) => {
			logger.error('Failed to send registration OTP email', err);
		});

		return {
			userId: user.id
		};
	}

	/**
	 * Resend OTP
	 */
	public async resendOtp(userId: string) {
		const user = await authRepository.findById(userId);
		if (!user) {
			throw new AppError('المستخدم غير موجود', 404);
		}
		if (user.status === UserStatus.ACTIVE) {
			throw new AppError('الحساب مفعل مسبقاً', 400);
		}

		const otpCode = crypto.randomInt(100000, 999999).toString();
		const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

		await authRepository.deleteUserOtps(user.id);
		await authRepository.createOtp(user.id, otpCode, OtpType.EMAIL, expiresAt);

		if (process.env.NODE_ENV === 'development') {
			logger.info(`[DEV OTP LOGGER] New Verification Code for ${user.email}: ${otpCode}`);
		}

		notificationService.sendEmailOtp(user.email, otpCode).catch((err: any) => {
			logger.error('Failed to send resend OTP email', err);
		});

		return true;
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

		const otpCode = crypto.randomInt(100000, 999999).toString();
		const expiresAt = new Date(Date.now() + RESET_OTP_EXPIRY_MS);

		await authRepository.deletePasswordResetOtps(user.id);
		await authRepository.createPasswordResetOtp(user.id, otpCode, expiresAt);

		if (process.env.NODE_ENV === 'development') {
			logger.info(`[DEV OTP LOGGER] Password reset code for ${user.email}: ${otpCode}`);
		}

		try {
			await notificationService.sendPasswordResetEmail(user.email, user.firstName, otpCode);
		} catch (err: any) {
			logger.error('Failed to send password reset email', err);
			// Keep the response generic even if delivery failed — avoids leaking
			// account existence and matches the rest of the reset flow's behavior.
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
			// Automatically generate and dispatch a fresh OTP to their email
			await this.resendOtp(user.id);

			return {
				verified: false,
				userId: user.id,
				message: 'يرجى تفعيل حسابك أولاً'
			};
		}

		if (user.status === UserStatus.SUSPENDED) {
			throw new AppError('هذا الحساب معطل حالياً، يرجى التواصل مع الدعم', 403);
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
	 */
	public async googleAuth(input: GoogleAuthInput, sessionContext: SessionContext = {}) {
		const ticket = await googleClient.verifyIdToken({
			idToken: input.idToken,
			audience: process.env.GOOGLE_CLIENT_ID,
		});
		
		const payload = ticket.getPayload();
		if (!payload) {
			throw new AppError('Google token invalid', 401);
		}

		const email = payload.email!;
		const existingUser = await authRepository.findByEmail(email);
		// Captured before any prisma.user.update() below, which returns a bare
		// scalar User (no relations) and would otherwise silently drop these.
		const roleRelations = {
			clientProfile: existingUser?.clientProfile,
			providerProfile: existingUser?.providerProfile,
			affiliateProfile: existingUser?.affiliateProfile
		};
		let user: Pick<PrismaUser, 'id' | 'email' | 'accountType' | 'activeRole' | 'roles' | 'status' | 'googleId' | 'firstName' | 'lastName'> | null = existingUser;

		if (!user) {
			if (!input.accountType) {
				throw new AppError('يرجى تحديد نوع الحساب للمتابعة بالتسجيل عن طريق جوجل', 400);
			}
			const accountType = input.accountType;
			const roles = getInitialRolesForAccountType(accountType);

			// Create User & a matching profile row for every owned role together,
			// atomically — same createMissingRoleProfiles helper as email/password
			// registration (auth.repository.ts) so the two signup paths can't
			// diverge on which profile rows a given accountType gets (e.g. a
			// Google PROVIDER signup previously ended up with no ProviderProfile
			// row at all).
			user = await prisma.$transaction(async (tx) => {
				const created = await tx.user.create({
					data: {
						email: email,
						firstName: payload.given_name || 'Google',
						lastName: payload.family_name || 'User',
						accountType,
						// Initialize roles/activeRole from the chosen accountType, same as
						// the email/password registration path (auth.repository.ts).
						roles,
						activeRole: getRoleFromAccountType(accountType),
						status: UserStatus.ACTIVE,
						authProvider: 'google',
						googleId: payload.sub,
						avatarUrl: payload.picture,
					}
				});

				// Phase 3D.4: full identity so Google signups (which legitimately
				// have an avatarUrl already, unlike email/password signups) get an
				// accurate initial completion score seeded from real state — not a
				// new formula, same calculators email/password registration uses.
				await createMissingRoleProfiles(tx, created.id, roles, {
					firstName: created.firstName,
					lastName: created.lastName,
					avatarUrl: created.avatarUrl,
					email: created.email,
					phoneNumber: created.phoneNumber,
					idNumber: created.idNumber,
					idExpiryDate: created.idExpiryDate,
					ibanNumber: created.ibanNumber,
					bankName: created.bankName,
					accountHolderName: created.accountHolderName,
					idDocumentUrl: created.idDocumentUrl
				});

				return created;
			});
		} else {
			if (!user.googleId) {
				user = await prisma.user.update({
					where: { id: user.id },
					data: { googleId: payload.sub, authProvider: 'google' }
				});
			}
			if (user.status === UserStatus.PENDING_VERIFICATION) {
				user = await prisma.user.update({
					where: { id: user.id },
					data: { status: UserStatus.ACTIVE }
				});
			}
		}

		if (user.status === UserStatus.SUSPENDED) {
			throw new AppError('هذا الحساب معطل حالياً، يرجى التواصل مع الدعم', 403);
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
}

export const authService = new AuthService();
