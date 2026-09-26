import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { authenticate, authorize, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { clientRequestsController } from '../controllers/client-requests.controller';
import { memoryUpload } from '../utils/cloudinary-storage';
import { openClientDispute } from '../controllers/dispute.controller';
import { rateAsClient, rateStage } from '../controllers/rating.controller';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'text/plain',
  'text/csv'
]);

const upload = memoryUpload({ fileSize: 15 * 1024 * 1024, files: 5, allowedMimeTypes: ALLOWED_MIME_TYPES });

const router = Router();

// Metadata endpoint (Categories, Specialties, Sub-specialties with provider counts)
router.get('/meta', clientRequestsController.getMeta);

// AI suggestion endpoint — client-only, active-account-only, AI-rate-limited,
// matching the same authorization pattern used by other client-restricted
// routes (e.g. cart-checkout.routes.ts's clientAuth chain).
router.post(
  '/ai-suggest',
  authenticate,
  requireActiveUser,
  authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL),
  aiLimiter,
  clientRequestsController.aiSuggest
);

// Multi-part file upload endpoint for attachments
router.post('/upload', authenticate, upload.array('attachments', 5), clientRequestsController.uploadAttachments);

// Create request endpoint
router.post('/', authenticate, requireActiveUser, clientRequestsController.createRequest);

// My requests list endpoint (MUST be before /:id)
router.get('/my-requests', authenticate, requireActiveUser, clientRequestsController.getMyRequests);

// Active projects list endpoint
router.get('/active-projects', authenticate, requireActiveUser, clientRequestsController.getActiveProjects);

// Completed/archived projects list endpoint
router.get('/completed-projects', authenticate, requireActiveUser, clientRequestsController.getCompletedProjects);

// Pending-review deliveries list (stages with a real submitted delivery
// awaiting this client's decision). MUST be registered before the generic
// GET /:id route below, or Express would treat "pending-deliveries" as an
// :id value and route it to getRequestDetails instead.
router.get('/pending-deliveries', authenticate, requireActiveUser, clientRequestsController.getPendingReviewDeliveries);

// Active project tracking details
router.get('/active-projects/:id', authenticate, requireActiveUser, clientRequestsController.getActiveProjectTracking);

router.get('/:id/workspace', authenticate, requireActiveUser, clientRequestsController.getProjectWorkspace);
router.post('/:id/stages/:stageId/review', authenticate, requireActiveUser, clientRequestsController.reviewStageDelivery);
// Advisory-only Gemini review of a stage delivery — read-only, no DB write,
// never approves/rejects the delivery. AI-rate-limited like every other
// Gemini-triggering HTTP route in this codebase. Ownership (must be this
// contract's own client) is enforced inside the service, matching the
// existing /review route's own pattern above.
router.post('/:id/stages/:stageId/ai-review', authenticate, requireActiveUser, aiLimiter, clientRequestsController.getDeliveryAiReview);

// Batch 8 — advisory-only Gemini project health analysis. Read-only, no DB
// write, never changes any status. Ownership (must be this contract's own
// client or provider) is enforced inside the shared service method.
router.post('/:id/health', authenticate, requireActiveUser, aiLimiter, clientRequestsController.getProjectHealthAnalysis);
router.post('/:id/stages/:stageId/rating', authenticate, requireActiveUser, rateStage);

// Request details by ID
router.get('/:id', authenticate, requireActiveUser, clientRequestsController.getRequestDetails);

// Sign contract & send OTP
router.post('/:id/offers/select', authenticate, requireActiveUser, clientRequestsController.selectOffer);

// Sign contract & send OTP
router.post('/:id/contract/sign', authenticate, requireActiveUser, clientRequestsController.signContract);

// Verify OTP & deposit escrow
router.post('/:id/escrow/deposit', authenticate, requireActiveUser, clientRequestsController.depositEscrow);
router.post('/:id/disputes', authenticate, requireActiveUser, openClientDispute);
router.post('/:id/rate', authenticate, requireActiveUser, rateAsClient);

export default router;
