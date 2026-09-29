import { Router, Request, Response, NextFunction } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { AppError } from '../utils/app-error';
import { createTeamMember, deleteTeamMember, getTeamMember, listTeamMembers, updateTeamMember } from '../controllers/company-team.controller';

// Mounted at /provider/company/team (see provider.routes.ts), i.e.
// /api/provider/company/team.
//
// authorize(PROVIDER_COMPANY) on its own also admits any user holding the
// PROVIDER role (role-equivalence in auth.middleware), which would let
// PROVIDER_INDIVIDUAL accounts through. A team roster only makes sense for a
// company account, so requireCompanyAccount additionally enforces the strict
// accountType — the same field the frontend's isCompanyMode is based on.
const requireCompanyAccount = (req: Request, _res: Response, next: NextFunction) => {
  if (req.user?.accountType !== AccountType.PROVIDER_COMPANY) {
    return next(new AppError('هذه الميزة متاحة لحسابات الشركات فقط', 403));
  }
  next();
};

const router = Router();

router.use(authenticate, requireActiveUser, authorize(AccountType.PROVIDER_COMPANY), requireCompanyAccount);

router.post('/', createTeamMember);
router.get('/', listTeamMembers);
router.get('/:id', getTeamMember);
router.put('/:id', updateTeamMember);
router.delete('/:id', deleteTeamMember);

export default router;
