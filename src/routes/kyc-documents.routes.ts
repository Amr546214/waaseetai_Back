import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { createAccessLink } from '../controllers/kyc-documents.controller';

const router = Router();

// POST /api/kyc-documents/access-link — the ONLY way to open a KYC document: owner or admin, active account, short-lived link.
router.post('/access-link', authenticate, requireActiveUser, createAccessLink);

export default router;
