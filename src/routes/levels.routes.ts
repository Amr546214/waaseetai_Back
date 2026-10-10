import { Router } from 'express';
import { getLevelsTable } from '../controllers/gamification.controller';

const router = Router();
// Public and read-only: the level ladders are not secret (they are the published loyalty program), nothing here is per user.
router.get('/', getLevelsTable);
export default router;
