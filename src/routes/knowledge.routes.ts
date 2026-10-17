import { Router } from 'express';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { searchKnowledge, listKnowledgeDocs, getKnowledgeDoc } from '../controllers/knowledge.controller';
import { optionalAuthenticate } from '../middlewares/auth.middleware';

const router = Router();
router.use(optionalAuthenticate);

// Knowledge / Policy retrieval routes
router.get('/search', aiLimiter, searchKnowledge);
router.get('/', listKnowledgeDocs);
router.get('/:id', getKnowledgeDoc);

export default router;
