import { Router } from 'express';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { clientRequestsController } from '../controllers/client-requests.controller';
import { memoryUpload } from '../utils/cloudinary-storage';

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

// AI suggestion endpoint
router.post('/ai-suggest', authenticate, clientRequestsController.aiSuggest);

// Multi-part file upload endpoint for attachments
router.post('/upload', authenticate, upload.array('attachments', 5), clientRequestsController.uploadAttachments);

// Create request endpoint
router.post('/', authenticate, requireActiveUser, clientRequestsController.createRequest);

// My requests list endpoint (MUST be before /:id)
router.get('/my-requests', authenticate, requireActiveUser, clientRequestsController.getMyRequests);

// Active projects list endpoint
router.get('/active-projects', authenticate, requireActiveUser, clientRequestsController.getActiveProjects);

// Active project tracking details
router.get('/active-projects/:id', authenticate, requireActiveUser, clientRequestsController.getActiveProjectTracking);

router.get('/:id/workspace', authenticate, requireActiveUser, clientRequestsController.getProjectWorkspace);
router.post('/:id/stages/:stageId/review', authenticate, requireActiveUser, clientRequestsController.reviewStageDelivery);

// Request details by ID
router.get('/:id', authenticate, requireActiveUser, clientRequestsController.getRequestDetails);

// Sign contract & send OTP
router.post('/:id/offers/select', authenticate, requireActiveUser, clientRequestsController.selectOffer);

// Sign contract & send OTP
router.post('/:id/contract/sign', authenticate, requireActiveUser, clientRequestsController.signContract);

// Verify OTP & deposit escrow
router.post('/:id/escrow/deposit', authenticate, requireActiveUser, clientRequestsController.depositEscrow);

export default router;
