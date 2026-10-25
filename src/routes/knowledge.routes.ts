import { Router } from 'express';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { searchKnowledge, listKnowledgeDocs, getKnowledgeDoc } from '../controllers/knowledge.controller';
import { optionalAuthenticate } from '../middlewares/auth.middleware';
import { adminHasAnyAccess } from '../services/admin-access.service';

const router = Router();
router.use(optionalAuthenticate);
// An ADMIN / SUPER_ADMIN account is privileged for knowledge (all audiences, other users' documents) only while it is the owner or active staff holding a permission; otherwise it is read as a guest.
router.use(async (req, _res, next) => {
	try {
		const t = req.user?.accountType;
		if ((t === 'ADMIN' || t === 'SUPER_ADMIN') && !(await adminHasAnyAccess(req.user!.id))) (req as any).knowledgeAdminDemoted = true;
		next();
	} catch (e) { next(e); }
});

// Knowledge / Policy retrieval routes
router.get('/search', aiLimiter, searchKnowledge);
router.get('/', listKnowledgeDocs);
router.get('/:id', getKnowledgeDoc);

export default router;
