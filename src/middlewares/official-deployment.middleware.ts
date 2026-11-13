import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/app-error';
import { isOfficialDeployment } from '../utils/deployment-identity';

export const OPERATIONS_PANEL_UNAVAILABLE = 'OPERATIONS_PANEL_OFFICIAL_ONLY';
/** The sensitive operations panel exists on the official deployment only. Any other environment answers 404-equivalent 403 for every method, whoever calls (even a SUPER_ADMIN). */
export const requireOfficialDeployment = (_req: Request, _res: Response, next: NextFunction) => {
	if (isOfficialDeployment()) return next();
	next(new AppError('لوحة الإعدادات التشغيلية متاحة على الموقع الرسمي فقط.', 403, undefined, OPERATIONS_PANEL_UNAVAILABLE));
};
