import { Router } from 'express';
import { assistantChat, analyzeProjectForProvider } from '../controllers/ai-assistant.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

// Apply authentication to AI assistant endpoints
router.use(authenticate);

router.post('/chat', async (req, res, next) => {
  await assistantChat(req, res);
});

router.get('/analyze-project/:projectId', async (req, res, next) => {
  await analyzeProjectForProvider(req, res);
});

router.post('/analyze-project', async (req, res, next) => {
  await analyzeProjectForProvider(req, res);
});

export default router;

