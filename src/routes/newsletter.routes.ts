import { Router } from 'express';
import { subscribeToNewsletter, unsubscribeFromNewsletter } from '../controllers/newsletter.controller';

const router = Router();

// Public endpoints — anonymous blog visitors subscribe/unsubscribe with just an email.
// Covered by the global apiLimiter applied in app.ts, matching other public routes.
router.post('/subscribe', subscribeToNewsletter);
router.post('/unsubscribe', unsubscribeFromNewsletter);

export default router;
