import { Request, Response, NextFunction } from 'express';
import { AccountType } from '@prisma/client';
import { AppError } from '../utils/app-error';

export const COMPANY_ACCOUNTS_UNAVAILABLE_MESSAGE = 'حسابات الشركات قريبًا';

export const isCompanyAccountType = (accountType: unknown): boolean =>
	accountType === AccountType.PROVIDER_COMPANY || accountType === AccountType.CLIENT_COMPANY;

// Company accounts are outside the current launch: their setup wizard refuses to save (so no profile is declared complete and no
// KYC review record is created for them). Nothing already stored for an existing company account is touched.
export const blockCompanySetup = (req: Request, _res: Response, next: NextFunction) => {
	if (isCompanyAccountType(req.user?.accountType)) return next(new AppError(COMPANY_ACCOUNTS_UNAVAILABLE_MESSAGE, 403));
	next();
};
