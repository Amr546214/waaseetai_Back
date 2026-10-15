import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser , authorizeActiveRole } from '../middlewares/auth.middleware';
import { clientProjectAmendmentsController } from '../controllers/client-project-amendments.controller';
import { setProjectAssignedEmployee } from '../controllers/client-project-assignment.controller';
import { paymentLimiter } from '../middlewares/rate-limit.middleware';
import { requireClientCompanyAccount } from './client-company-team.routes';

const router = Router();
// The role the user is acting as RIGHT NOW decides (a provider acting as a provider never reaches the client's amendment flows).
const clientOnly = authorizeActiveRole(AccountType.CLIENT_INDIVIDUAL, AccountType.CLIENT_COMPANY);

router.use(authenticate, requireActiveUser);

// Literal-segment routes are registered before the ':projectId' param route so
// Express never mistakes "amendments" for a project id.
router.get('/amendments', clientOnly, clientProjectAmendmentsController.listAmendments);
router.post('/amendments/:id/respond', clientOnly, clientProjectAmendmentsController.respondToAmendment);
router.post('/amendments/:id/payment-otp', clientOnly, paymentLimiter, clientProjectAmendmentsController.initPaymentAuthorization);
router.post('/amendments/:id/authorize-funding', clientOnly, paymentLimiter, clientProjectAmendmentsController.authorizeFunding);
router.post('/amendments/:id/cancel', clientOnly, clientProjectAmendmentsController.cancelAmendment);
router.post('/:projectId/amendments', clientOnly, clientProjectAmendmentsController.createAmendment);

// Batch 6 — Client Company "responsible employee" assignment. Company-only
// (CLIENT_INDIVIDUAL has no employee concept) — reuses the exact same
// strict-accountType guard already built for the roster CRUD, since
// authorize(CLIENT_COMPANY) alone would also admit CLIENT_INDIVIDUAL via
// role-equivalence (see client-company-team.routes.ts).
router.put(
	'/:id/assigned-employee',
	authorizeActiveRole(AccountType.CLIENT_COMPANY),
	requireClientCompanyAccount,
	setProjectAssignedEmployee
);

export default router;
