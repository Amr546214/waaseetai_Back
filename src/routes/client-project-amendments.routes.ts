import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { clientProjectAmendmentsController } from '../controllers/client-project-amendments.controller';
import { setProjectAssignedEmployee } from '../controllers/client-project-assignment.controller';
import { requireClientCompanyAccount } from './client-company-team.routes';

const router = Router();

router.use(authenticate, requireActiveUser);

// Literal-segment routes are registered before the ':projectId' param route so
// Express never mistakes "amendments" for a project id.
router.get('/amendments', clientProjectAmendmentsController.listAmendments);
router.post('/amendments/:id/respond', clientProjectAmendmentsController.respondToAmendment);
router.post('/:projectId/amendments', clientProjectAmendmentsController.createAmendment);

// Batch 6 — Client Company "responsible employee" assignment. Company-only
// (CLIENT_INDIVIDUAL has no employee concept) — reuses the exact same
// strict-accountType guard already built for the roster CRUD, since
// authorize(CLIENT_COMPANY) alone would also admit CLIENT_INDIVIDUAL via
// role-equivalence (see client-company-team.routes.ts).
router.put(
	'/:id/assigned-employee',
	authorize(AccountType.CLIENT_COMPANY),
	requireClientCompanyAccount,
	setProjectAssignedEmployee
);

export default router;
