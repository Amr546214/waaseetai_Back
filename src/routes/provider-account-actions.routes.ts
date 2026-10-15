import { Router, Request, Response, NextFunction } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, requireActiveUser, authorizeActiveRole } from '../middlewares/auth.middleware';
import { approvalRequestService } from '../services/approval-request.service';

const router = Router();

// «إجراءات الحساب»: the provider's own approval requests and their real status. Deliberately NOT behind requireApprovedProvider (it is where an
// unapproved provider waits), but only the OWNER reads a request: a stranger's id is the same 404 as a missing one.
router.use(authenticate, requireActiveUser, authorizeActiveRole(AccountType.PROVIDER_INDIVIDUAL, AccountType.PROVIDER_COMPANY));

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
	try { res.json({ success: true, data: await approvalRequestService.list(req.user!.id) }); } catch (error) { next(error); }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
	try { res.json({ success: true, data: await approvalRequestService.get(req.user!.id, String(req.params['id'])) }); } catch (error) { next(error); }
});

/** The data «استكمال البيانات» opens with (previous content, fields to fix, attached documents); 409 when the request is not waiting for the provider. */
router.get('/:id/completion', async (req: Request, res: Response, next: NextFunction) => {
	try { res.json({ success: true, data: await approvalRequestService.getForCompletion(req.user!.id, String(req.params['id'])) }); } catch (error) { next(error); }
});

export default router;
