import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { getMyUsername, setMyUsername } from '../controllers/username.controller';

const router = Router();
// GET/PUT /api/username — the signed-in user's own username (the name shown on the platform). Separate from the legal name.
router.get('/', authenticate, requireActiveUser, getMyUsername);
router.put('/', authenticate, requireActiveUser, setMyUsername);
export default router;
