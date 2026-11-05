import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { ownerGetIdentityCheck } from '../controllers/identity-field-check.controller';

const router = Router();
// GET /api/identity-check/me?party=CLIENT|PROVIDER — neutral «قيد الفحص» state for the account owner (no field results, ever).
router.get('/me', authenticate, requireActiveUser, ownerGetIdentityCheck);
export default router;
