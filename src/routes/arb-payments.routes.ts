import { Router } from 'express';
import { arbBrowserError, arbBrowserResponse, arbNotification, arbWebhook } from '../controllers/arb.controller';

const router = Router();

// Intentionally PUBLIC: the bank's browser redirect and server notification cannot carry a WaseetAI JWT. Nothing here trusts the request —
// the service decrypts with the Resource Key, binds to a stored attempt and verifies with the bank (Inquiry) before any money is applied.
router.get('/response', arbBrowserResponse);
router.post('/response', arbBrowserResponse);
router.get('/error', arbBrowserError);
router.post('/error', arbBrowserError);
router.post('/notify', arbNotification);
router.post('/webhook', arbWebhook);

export default router;
