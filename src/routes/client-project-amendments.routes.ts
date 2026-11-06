import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser , authorizeActiveRole } from '../middlewares/auth.middleware';
import { clientProjectAmendmentsController } from '../controllers/client-project-amendments.controller';
import { setProjectAssignedEmployee } from '../controllers/client-project-assignment.controller';
import { paymentLimiter } from '../middlewares/rate-limit.middleware';
import { cancellationController } from '../controllers/contract-cancellation.controller';
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
// «الإلغاء بالتراضي»: a recorded request answered by the provider; it never moves money (see contract-cancellation.service.ts).
const cancel = cancellationController('CLIENT');
router.post('/cancellation-requests/:id/respond', clientOnly, cancel.respond);
router.post('/cancellation-requests/:id/withdraw', clientOnly, cancel.withdraw);
router.get('/:projectId/cancellation-requests', clientOnly, cancel.list);
router.post('/:projectId/cancellation-requests', clientOnly, cancel.create);
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
