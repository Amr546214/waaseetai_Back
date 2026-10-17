import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, requireActiveUser, authorizeActiveRole } from '../middlewares/auth.middleware';
import * as skillsController from '../controllers/skills.controller';

const router = Router();

// Mounted at /api/skills. The catalog (src/config/skills-catalog.config.ts) is readable by any authenticated user; provider-mine is the provider's own data.
router.use(authenticate, requireActiveUser);
router.get('/catalog/all', skillsController.getSkillsCatalogAll);
router.get('/catalog', skillsController.getSkillsCatalog);
router.get('/provider-mine', authorizeActiveRole(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY), skillsController.getProviderMine);

export default router;
