import { Request, Response, NextFunction } from 'express';
import { AccountType, UserRole } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { providerAccessStateService, DASHBOARD_LOCKED_MESSAGE } from '../services/provider-access-state.service';

/**
 * Hard guard for the provider-dashboard DATA endpoints: an individual provider ACTING as a provider (activeRole) gets 403 until at least one of their
 * specialties is APPROVED by the admin. Companies, non-providers and a provider acting as a client pass through untouched (their own role guards decide).
 * Must run after authenticate. Never applied to profile / setup / accreditation / access-state / notifications / tickets / KYC routes.
 */
export const requireApprovedProvider = async (req: Request, _res: Response, next: NextFunction) => {
	try {
		if (!req.user) return next(new AppError('غير مصرح لك بالوصول، يرجى تسجيل الدخول', 401));
		if (req.user.accountType !== AccountType.PROVIDER_INDIVIDUAL) return next();
		const acting = req.user.activeRole ?? UserRole.PROVIDER;
		if (acting !== UserRole.PROVIDER) return next();
		const access = await providerAccessStateService.get(req.user.id);
		if (!access.canAccessDashboard) return next(new AppError(DASHBOARD_LOCKED_MESSAGE, 403));
		next();
	} catch (error) { next(error); }
};
