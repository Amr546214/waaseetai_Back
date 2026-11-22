import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { getMyLegalName, setMyLegalName, cancelMyLegalNameRequest } from '../controllers/legal-name.controller';

const router = Router();
// GET/PUT /api/legal-name — the signed-in user's own legal name (the name on the identity document). Separate from the display name.
router.get('/', authenticate, requireActiveUser, getMyLegalName);
router.put('/', authenticate, requireActiveUser, setMyLegalName);
router.post('/request/cancel', authenticate, requireActiveUser, cancelMyLegalNameRequest);
export default router;
