import { Router } from 'express';
import { AccountType } from '@prisma/client';
import { marketerOverviewController } from '../controllers/marketer-overview.controller';
import { submitMarketerWithdrawal, listMyMarketerWithdrawals } from '../controllers/withdrawal.controller';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { AccountType } from '@prisma/client';
import { validateDto } from '../middlewares/validate-dto.middleware';
import { createCustomLinkSchema, updateRefSettingsSchema } from '../dtos/marketer-overview.dto';
import { authenticate, authorizeActiveRoleWithMessage, requireActiveUser } from '../middlewares/auth.middleware';
import { createTicket, listMyTickets, getMyTicket, replyToTicket, closeMyTicket } from '../controllers/support-ticket.controller';
import { getMarketerWallet, getMyMarketerWithdrawal, getMarketerAssets, getMarketerSettings, updateMarketerSettings, exportMarketerData } from '../controllers/marketer-account.controller';

const router = Router();

// Protect all routes: the role the user is acting as RIGHT NOW must be the marketer (every account also holds CLIENT, so merely having the role is not enough)
router.use(authenticate, requireActiveUser);
router.use(authorizeActiveRoleWithMessage('بدّل إلى حساب الوسيط التسويقي للوصول إلى هذه الصفحة', AccountType.MARKETING_BROKER));

router.get('/summary', marketerOverviewController.getSummary);
router.get('/channel-performance', marketerOverviewController.getChannelPerformance);
router.get('/commissions', marketerOverviewController.getCommissions);
router.get('/ai-insights', aiLimiter, marketerOverviewController.getAiInsights);

// Referred users (paginated) — strictly scoped to req.user.id's own
// AffiliateProfile inside the service (getOrCreateProfile()); never accepts
// another affiliate's id.
router.get('/referrals', marketerOverviewController.getReferrals);

// Referral links
router.get('/ref-links', marketerOverviewController.getRefLinks);
router.post('/ref-links/custom', validateDto(createCustomLinkSchema), marketerOverviewController.createCustomLink);
router.delete('/ref-links/custom/:id', marketerOverviewController.deleteCustomLink);
router.patch('/ref-links/settings', validateDto(updateRefSettingsSchema), marketerOverviewController.updateSettings);

// Withdrawals — reuses the same generic, userId-scoped Withdrawal model and
// listMyWithdrawals controller the provider finance flow already uses.
router.post('/withdrawals', submitMarketerWithdrawal);
router.get('/withdrawals', listMyMarketerWithdrawals);
router.get('/withdrawals/:id', getMyMarketerWithdrawal);
// The marketer's money in one read: approved earnings, reserved / paid withdrawals and the withdrawable balance the server enforces. Never the client wallet.
router.get('/wallet', getMarketerWallet);

// Files an admin published for marketers (empty until something is published)
router.get('/assets', getMarketerAssets);

// Settings: notification switches, communication language, timezone; and the marketer's own data as a JSON file
router.get('/settings', getMarketerSettings);
router.patch('/settings', updateMarketerSettings);
router.get('/settings/data-export', exportMarketerData);

// Support tickets: the same role-agnostic ticket system the other sides use, scoped to req.user (someone else's ticket is a 404)
router.post('/tickets', createTicket);
router.get('/tickets', listMyTickets);
router.get('/tickets/:id', getMyTicket);
router.post('/tickets/:id/reply', replyToTicket);
router.post('/tickets/:id/close', closeMyTicket);

export default router;
