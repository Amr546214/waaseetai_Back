import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { sessionService } from '../services/session.service';
import { getAuthCookie } from '../utils/request-cookie';
import { RegisterInput, VerifyOtpInput, LoginInput, GoogleAuthInput } from '../routes/auth/auth.schema';

export class AuthController {
	/**
	 * Handle user registration
	 */
	public async register(req: Request, res: Response, next: NextFunction) {
		try {
			// Body is pre-validated by Zod middleware
			const input: RegisterInput = req.body;

			const result = await authService.registerUser(input);

			res.status(201).json({
				success: true,
				message: 'تم التسجيل بنجاح، يرجى تفعيل الحساب',
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
			await authService.resendOtp(userId);

			res.status(200).json({
				success: true,
				message: 'تم إعادة إرسال رمز التحقق بنجاح'
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
						userId: result.userId
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
	 * Handle Google login/registration
	 */
	public async googleAuth(req: Request, res: Response, next: NextFunction) {
		try {
			const input: GoogleAuthInput = req.body;
			const result = await authService.googleAuth(input, { ipAddress: req.ip, userAgent: req.get('user-agent') });

			res.status(200).json({
				success: true,
				message: 'تم تسجيل الدخول بواسطة جوجل بنجاح',
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
