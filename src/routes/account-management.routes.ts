import { Router } from 'express';
import { accountManagementController } from '../controllers/account-management.controller';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { AddAccountTypeSchema, SwitchActiveRoleSchema } from '../dtos/account-management.dto';

const router = Router();

router.use(authenticate, requireActiveUser);

router.get('/available-account-types', (req, res, next) => accountManagementController.getAvailableAccountTypes(req, res, next));
router.post('/add-account-type', validateDto(AddAccountTypeSchema), (req, res, next) => accountManagementController.addAccountType(req, res, next));
router.post('/switch-active-role', validateDto(SwitchActiveRoleSchema), (req, res, next) => accountManagementController.switchActiveRole(req, res, next));

export default router;
