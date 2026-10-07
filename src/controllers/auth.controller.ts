import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { sessionService } from '../services/session.service';
import { getAuthCookie, getRequestCookie } from '../utils/request-cookie';
import { RegisterInput, VerifyOtpInput, LoginInput, GoogleAuthInput, ForgotPasswordInput, VerifyResetCodeInput, ResetPasswordInput, VerifyLoginOtpInput, ResendLoginOtpInput } from '../routes/auth/auth.schema';

export class AuthController {
	/**
	 * Handle user registration
	 */
	public async register(req: Request, res: Response, next: NextFunction) {
		try {
			// Body is pre-validated by Zod middleware
			const input: RegisterInput = req.body;
			// waseet_ref_code is set by ref.controller.ts::handleReferralClick()
			// when a visitor followed an affiliate's /ref/:slug link. Per
			// First-Touch (P-LG-012), a valid cookie attribution wins even when
			// the registration form ALSO supplied an explicit affiliateIdentifier
			// — see auth.service.ts::resolveReferralAttribution() for the exact
			// precedence rule.
			//
			// This codebase has no cookie-parser middleware registered (app.ts
			// never calls app.use(cookieParser())), so req.cookies is always
			// undefined here — the same reason logout()/getAuthCookie() above
			// read raw cookies via request-cookie.ts's manual header parser
			// instead. Reused here rather than adding req.cookies, which would
			// silently read nothing.
			const refCookieSlug = getRequestCookie(req, 'waseet_ref_code');

			const result = await authService.registerUser(input, { refCookieSlug });

			res.status(201).json({
				success: true,
				// emailSent=false: the account exists but the code email did not go out; the app must say so and offer a resend.
				message: result.emailSent
					? 'تم التسجيل بنجاح، يرجى تفعيل الحساب'
					: 'تم إنشاء الحساب لكن تعذر إرسال رمز التحقق إلى بريدك الآن. حاول إعادة الإرسال بعد قليل أو تواصل مع الدعم',
				data: result
			});
		} catch (error) {
			// Pass errors to the global error handler gracefully
			next(error);
		}
	}

	/**
	 * Handle OTP verification
	 */
	public async verifyOtp(req: Request, res: Response, next: NextFunction) {
		try {
			const input: VerifyOtpInput = req.body;
			const result = await authService.verifyOtp(input, { ipAddress: req.ip, userAgent: req.get('user-agent') });

			res.status(200).json({
				success: true,
				message: 'تم تفعيل الحساب بنجاح',
				data: result
			});
		} catch (error) {
			next(error);
		}
	}

	/**
	 * Resend OTP
	 */
	public async resendOtp(req: Request, res: Response, next: NextFunction) {
		try {
			const { userId } = req.body;
			const { emailSent } = await authService.resendOtp(userId);

			// success:false when the email did not go out, so an older app version that only reads `success` / `message`
			// does not claim the code was sent.
			res.status(200).json({
				success: emailSent,
				emailSent,
				message: emailSent
					? 'تم إعادة إرسال رمز التحقق بنجاح'
					: 'تعذر إرسال رمز التحقق، حاول مرة أخرى بعد قليل أو تواصل مع الدعم',
				data: { emailSent }
			});
		} catch (error) {
			next(error);
		}
	}

	/**
	 * Request a password-reset code by email
	 */
	public async forgotPassword(req: Request, res: Response, next: NextFunction) {
		try {
			const input: ForgotPasswordInput = req.body;
			const result = await authService.forgotPassword(input);

			res.status(200).json({
				success: true,
				message: result.message
			});
		} catch (error) {
			next(error);
		}
	}

	/**
	 * Verify a password-reset code (without consuming it)
	 */
	public async verifyResetCode(req: Request, res: Response, next: NextFunction) {
		try {
			const input: VerifyResetCodeInput = req.body;
			await authService.verifyResetCode(input);

			res.status(200).json({
				success: true,
				message: 'تم التحقق من الرمز بنجاح'
			});
		} catch (error) {
			next(error);
		}
	}

	/**
	 * Reset the password using a verified code
	 */
	public async resetPassword(req: Request, res: Response, next: NextFunction) {
		try {
			const input: ResetPasswordInput = req.body;
			const result = await authService.resetPassword(input);

			res.status(200).json({
				success: true,
				message: result.message
			});
		} catch (error) {
			next(error);
		}
	}

	/**
	 * Handle user login
	 */
	public async login(req: Request, res: Response, next: NextFunction) {
		try {
			const input: LoginInput = req.body;
			const result = await authService.loginUser(input, { ipAddress: req.ip, userAgent: req.get('user-agent') });

			if (!result.verified) {
				res.status(200).json({
					success: true,
					message: result.message,
					data: {
						verified: false,
						phoneOtpRequired: result.phoneOtpRequired,
						userId: result.userId,
						// Unverified account: whether the activation email really went out, and the wait when the send was throttled.
						...('emailSent' in result ? { emailSent: result.emailSent } : {}),
						...('retryAfterSeconds' in result ? { retryAfterSeconds: result.retryAfterSeconds } : {})
					}
				});
				return;
			}

			res.status(200).json({
				success: true,
				message: 'تم تسجيل الدخول بنجاح',
				data: {
					verified: true,
					token: result.token,
					user: result.user
				}
			});
		} catch (error) {
			next(error);
		}
	}

	/**
	 * Verify the login-time phone OTP and issue the session
	 */
	public async verifyLoginOtp(req: Request, res: Response, next: NextFunction) {
		try {
			const input: VerifyLoginOtpInput = req.body;
			const result = await authService.verifyLoginOtp(input, { ipAddress: req.ip, userAgent: req.get('user-agent') });

			res.status(200).json({
				success: true,
				message: 'تم تسجيل الدخول بنجاح',
				data: result
			});
		} catch (error) {
			next(error);
		}
	}

	/**
	 * Resend the login-time phone OTP
	 */
	public async resendLoginOtp(req: Request, res: Response, next: NextFunction) {
		try {
			const { userId }: ResendLoginOtpInput = req.body;
			await authService.resendLoginOtp(userId);

			res.status(200).json({
				success: true,
				message: 'تم إعادة إرسال رمز التحقق بنجاح'
			});
		} catch (error) {
			next(error);
		}
	}

	/**
	 * Handle Google login/registration
	 */
	public async googleAuth(req: Request, res: Response, next: NextFunction) {
		try {
			const input: GoogleAuthInput = req.body;
			// See register()'s identical read above (including the note on why
			// req.cookies can't be used) — threaded through for symmetry/future
			// use (actual Google-driven account creation currently happens via
			// POST /register with googleIdToken set, not via this endpoint's
			// 'register' intent branch, which never creates a user — see
			// auth.service.ts::googleAuth()'s comment).
			const refCookieSlug = getRequestCookie(req, 'waseet_ref_code');
			const result = await authService.googleAuth(input, { ipAddress: req.ip, userAgent: req.get('user-agent') }, { refCookieSlug });

			res.status(200).json({
				success: true,
				message: result.verified ? 'تم تسجيل الدخول بواسطة جوجل بنجاح' : 'يرجى استكمال خطوات التسجيل والتحقق',
				data: result
			});
		} catch (error) {
			next(error);
		}
	}

	/**
	 * GET /auth/account-status — the caller's OWN account status, readable in every state (including suspended / pending), so a blocked
	 * account can be told why. Nothing else is returned.
	 */
	public async accountStatus(req: Request, res: Response, next: NextFunction) {
		try {
			const status = req.user!.status;
			const messages: Record<string, string> = {
				ACTIVE: 'حسابك نشط',
				PENDING_VERIFICATION: 'حسابك بانتظار التفعيل برمز التحقق',
				SUSPENDED: 'هذا الحساب معطل حالياً، يرجى التواصل مع الدعم',
				SUSPENDED_REVIEW: 'هذا الحساب قيد مراجعة الإيقاف حالياً، يرجى التواصل مع الدعم'
			};
			res.status(200).json({ success: true, data: { status, message: messages[String(status)] ?? '' } });
		} catch (error) {
			next(error);
		}
	}

	/**
	 * Handle user logout and session revocation
	 */
	public async logout(req: Request, res: Response, next: NextFunction) {
		try {
			const authHeader = req.headers.authorization;
			const token = authHeader && authHeader.startsWith('Bearer ')
				? authHeader.split(' ')[1]
				: getAuthCookie(req);

			if (token && req.user) {
				await sessionService.logout(req.user.userId, token, {
					ipAddress: req.ip,
					userAgent: req.get('user-agent')
				});
			}

			res.status(200).json({
				success: true,
				message: 'تم تسجيل الخروج بنجاح'
			});
		} catch (error) {
			next(error);
		}
	}
}

export const authController = new AuthController();
