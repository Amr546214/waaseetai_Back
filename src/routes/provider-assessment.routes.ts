import { Router } from 'express';
import { startDynamicSession } from '../controllers/provider-assessment.controller';

const router = Router();

router.post('/start-dynamic-session', startDynamicSession);

export default router;
