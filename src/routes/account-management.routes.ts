import { Router } from 'express';
import { accountManagementController } from '../controllers/account-management.controller';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { AddAccountTypeSchema, SwitchActiveRoleSchema } from '../dtos/account-management.dto';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { suggestSkillsFromCatalog } from '../controllers/provider-profile.controller';

const router = Router();

router.use(authenticate, requireActiveUser);

router.get('/available-account-types', (req, res, next) => accountManagementController.getAvailableAccountTypes(req, res, next));
router.post('/add-account-type', validateDto(AddAccountTypeSchema), (req, res, next) => accountManagementController.addAccountType(req, res, next));
// the add-account wizard of a CLIENT who is adding a provider account (not a provider yet): the same AI skills suggestion, from the draft specialty only
router.post('/suggest-skills', aiLimiter, suggestSkillsFromCatalog);
router.post('/switch-active-role', validateDto(SwitchActiveRoleSchema), (req, res, next) => accountManagementController.switchActiveRole(req, res, next));

export default router;
