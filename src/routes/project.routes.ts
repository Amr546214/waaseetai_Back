import { Router } from 'express';
import { projectController } from '../controllers/project.controller';
import { proposalController } from '../controllers/proposal.controller';
import { projectAmendmentsController } from '../controllers/project-amendments.controller';
import { authenticate, requireActiveUser, authorize } from '../middlewares/auth.middleware';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { createProposalSchema } from '../dtos/create-proposal.dto';
import { createProjectSchema } from '../dtos/project.dto';
import { amendmentAnalysisSchema } from '../dtos/amendment-analysis.dto';
import { AccountType } from '@prisma/client';

const router = Router();

// Fetch user's own project requests
router.get(
  '/my-requests',
  authenticate,
  requireActiveUser,
  projectController.getMyRequests
);

// Get summary of a specific project for proposal application wizard
router.get(
  '/:id/summary',
  authenticate,
  projectController.getSummary
);

// Get specific project details directly via project ID
router.get(
  '/:id',
  authenticate,
  projectController.getSummary
);

// Analyze a proposed project amendment without creating or mutating amendment state
router.post(
  '/:id/amendments/ai-analysis',
  authenticate,
  requireActiveUser,
  authorize(
    AccountType.CLIENT_COMPANY,
    AccountType.CLIENT_INDIVIDUAL,
    AccountType.PROVIDER_COMPANY,
    AccountType.PROVIDER_INDIVIDUAL
  ),
  validateDto(amendmentAnalysisSchema),
  projectAmendmentsController.analyzeAmendmentImpact
);

// Submit a proposal for an open project
router.post(
  '/:id/proposals',
  authenticate,
  requireActiveUser,
  authorize(AccountType.PROVIDER_COMPANY, AccountType.PROVIDER_INDIVIDUAL, AccountType.MARKETING_BROKER),
  validateDto(createProposalSchema),
  proposalController.createProposal
);

// Only CLIENT_COMPANY or CLIENT_INDIVIDUAL can create projects
// And they must be Active
router.post(
  '/', 
  authenticate, 
  requireActiveUser, 
  authorize(AccountType.CLIENT_COMPANY, AccountType.CLIENT_INDIVIDUAL),
  validateDto(createProjectSchema),
  projectController.createProject
);

export default router;
