import { Router } from 'express';
import { handlePaypalWebhook } from '../controllers/paypal-webhook.controller';

const router = Router();

// Intentionally PUBLIC — PayPal calls this server-to-server and cannot
// present a WaseetAI JWT. Authenticity is verified inside the handler via
// PayPal's own webhook signature verification API, not by auth middleware.
router.post('/webhook', handlePaypalWebhook);

export default router;
