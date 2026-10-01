import { Router, Request, Response, NextFunction } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { AppError } from '../utils/app-error';
import {
	createClientTeamMember,
	deleteClientTeamMember,
	getClientTeamMember,
	listClientTeamMembers,
	updateClientTeamMember
} from '../controllers/client-company-team.controller';

// Mounted at /client/company/team (see app.ts), i.e. /api/client/company/team.
//
// authorize(CLIENT_COMPANY) on its own also admits any user holding the
// CLIENT role (role-equivalence in auth.middleware), which would let
// CLIENT_INDIVIDUAL accounts through — same loophole already worked around
// by company-team.routes.ts's requireCompanyAccount for the provider side.
// requireClientCompanyAccount additionally enforces the strict accountType.
export const requireClientCompanyAccount = (req: Request, _res: Response, next: NextFunction) => {
	if (req.user?.accountType !== AccountType.CLIENT_COMPANY) {
		return next(new AppError('هذه الميزة متاحة لحسابات الشركات فقط', 403));
	}
	next();
};

const router = Router();

router.use(authenticate, requireActiveUser, authorize(AccountType.CLIENT_COMPANY), requireClientCompanyAccount);

router.post('/', createClientTeamMember);
router.get('/', listClientTeamMembers);
router.get('/:id', getClientTeamMember);
router.put('/:id', updateClientTeamMember);
router.delete('/:id', deleteClientTeamMember);

export default router;
