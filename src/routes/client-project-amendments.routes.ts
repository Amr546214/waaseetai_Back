import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { clientProjectAmendmentsController } from '../controllers/client-project-amendments.controller';

const router = Router();

router.use(authenticate, requireActiveUser);

// Literal-segment routes are registered before the ':projectId' param route so
// Express never mistakes "amendments" for a project id.
router.get('/amendments', clientProjectAmendmentsController.listAmendments);
router.post('/amendments/:id/respond', clientProjectAmendmentsController.respondToAmendment);
router.post('/:projectId/amendments', clientProjectAmendmentsController.createAmendment);

export default router;
