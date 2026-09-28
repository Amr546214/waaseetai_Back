import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { initSocketServer } from './socket';
import { logger } from './config/logger';
import { globalErrorHandler } from './middlewares/error.middleware';
import { apiLimiter } from './middlewares/rate-limit.middleware';
import { AppError } from './utils/app-error';
import authRouter from './routes/auth/auth.routes';
import profileRouter from './routes/profile/profile.routes';
import dashboardRouter from './routes/dashboard/dashboard.routes';
import projectRouter from './routes/project.routes';
import aiAssistantRouter from './routes/ai-assistant.routes';
import providerRouter from './routes/provider.routes';
import proposalRouter from './routes/proposal.routes';
import chatRouter from './routes/chat.routes';
import aiReviewRouter from './modules/ai-review/ai-review.routes';
import cartCheckoutRouter from './routes/cart-checkout.routes';

import providerProfileRoutes from './routes/provider-profile.routes';
import specialtyRoutes from './routes/specialty.routes';
import providerSpecialtyRoutes from './routes/provider-specialty.routes';
import gamificationRoutes from './routes/gamification.routes';
import accountLogsRoutes from './routes/account-logs.routes';
import clientProfileRoutes from './routes/client-profile.routes';
import clientRequestsRoutes from './routes/client-requests.routes';
import clientProjectAmendmentsRoutes from './routes/client-project-amendments.routes';
import businessModelsRouter from './routes/business-models.routes';
import marketplaceRouter from './routes/marketplace.routes';
import notificationsRouter from './routes/notifications.routes';
import marketerOverviewRouter from './routes/marketer-overview.routes';
import marketerProfileRouter from './routes/marketer-profile.routes';
import refRouter from './routes/ref.routes';
import accreditationAiRoutes from './routes/accreditation-ai.routes';
import swaggerUi from 'swagger-ui-express';
import { createOpenApiDocument } from './config/swagger';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();

// Trust the local reverse proxy only, by its actual verified identity, not a
// blind hop count. Confirmed topology (DEV, /etc/nginx/sites-available/
// dev.waseetai.com): a single host-level nginx terminates TLS and does
// `proxy_pass http://127.0.0.1:5009` for /api/, appending the real client IP
// via `X-Forwarded-For: $proxy_add_x_forwarded_for` — exactly one hop.
//
// That hop does NOT arrive at Express as 127.0.0.1: this app runs inside a
// Docker container with the port published (`-p 5009:5009`), so nginx's
// connection is rewritten by Docker's port-publishing NAT to arrive from the
// bridge network's gateway address instead (confirmed via `docker network
// inspect waseetai-network`: subnet 172.23.0.0/16, gateway 172.23.0.1) — an
// initial 'loopback' setting was deployed and verified NOT to match this
// address (real external requests still logged the flat gateway IP), so it
// was corrected to 'uniquelocal', Express's built-in preset for private/
// RFC1918 ranges (10/8, 172.16/12, 192.168/16, 127/8, and their IPv6
// equivalents). 172.23.0.1 falls within 172.16.0.0/12, so this correctly
// trusts the real proxy hop without hardcoding a specific gateway IP that
// could silently go stale if the Docker network is ever recreated with a
// different subnet. A bare numeric hop count (`trust proxy: 1`) was
// deliberately NOT used either: this container's port is also published
// directly to the host (0.0.0.0:5009, a separate pre-existing exposure, out
// of scope for this fix), so a request that bypasses nginx entirely could
// hand Express a self-forged X-Forwarded-For header — a hop-count setting
// would trust that forged header just as readily as a real one, whereas a
// direct caller's real public IP is never itself a private/RFC1918 address.
//
// Without this, req.ip (and therefore express-rate-limit's per-client
// bucketing) fell back to the raw socket address for every request, which
// behind this proxy is always the same Docker gateway address — collapsing
// every real visitor into one shared rate-limit bucket. That is what
// produced the 429 on GET /api/marketer/profile during active multi-user
// DEV testing.
app.set('trust proxy', 'uniquelocal');

// ==========================================
// 1. SECURITY & MIDDLEWARES
// ==========================================

// Set security HTTP headers
app.use(
	helmet({
		crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
		crossOriginResourcePolicy: { policy: 'cross-origin' },
	})
);

// Strict CORS configuration
const defaultAllowedOrigins = [
	'https://dev.waseetai.com',
	'https://waseetai.com',
	'http://localhost:3000',
	'http://localhost:4200',
	'http://127.0.0.1:4200',
	'http://127.0.0.1:49538',
	'http://localhost:5009',
	'https://api.waseetai.com'
];
const configuredOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
	.split(',')
	.map(origin => origin.trim())
	.filter(Boolean);
const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...configuredOrigins])];

app.use(
	cors({
		origin: (origin, callback) => {
			// Allow requests with no origin (like mobile apps or curl requests)
			if (!origin) return callback(null, true);

			if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
				callback(null, true);
			} else {
				callback(new AppError('Not allowed by CORS', 403));
			}
		},
		credentials: true,
	})
);

// Apply rate limiting to both /api-prefixed and reverse-proxy unprefixed routes.
app.use(apiLimiter);

// Request Parsing
// `verify` captures the exact raw bytes alongside the normal parsed req.body,
// for every JSON request, at no extra cost to existing routes — needed so
// the PayPal webhook handler can check its signature against the bytes as
// sent (re-serializing the parsed object would not reliably match).
app.use(express.json({
	limit: '10mb',
	verify: (req: Request, _res: Response, buf: Buffer) => {
		req.rawBody = buf;
	}
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==========================================
// 2. LOGGING
// ==========================================

// Integrate Morgan with Winston logger
app.use(
	morgan('combined', {
		stream: {
			write: (message: string) => logger.info(message.trim()),
		},
	})
);

// ==========================================
// 3. ROUTES
// ==========================================

// Health Check Endpoint
app.get('/api', (req: Request, res: Response) => {
	res.status(200).json({
		success: true,
		message: 'Waseet AI Core API is operational'
	});
});

// Lightweight container/load-balancer probe. Keep this endpoint unauthenticated
// and free of database calls so it can still report process health during DB
// startup or maintenance.
app.get('/health', (_req: Request, res: Response) => {
	res.status(200).json({ success: true, status: 'ok', service: 'waseetai-backend' });
});
app.get('/api/health', (_req: Request, res: Response) => {
	res.status(200).json({ success: true, status: 'ok', service: 'waseetai-backend' });
});

// Create a centralized API router
const apiRouter = express.Router();

const mountAppRoute = (path: string, router: express.Router) => {
	app.use(path, router);
	const stack = (app as unknown as express.Application & { router?: { stack?: Array<Record<string, unknown>> } }).router?.stack;
	const layer = stack?.at(-1);
	if (layer) (layer as unknown as Record<string, unknown>).__swaggerPath = path;
};

// Keep mount metadata on router layers so the OpenAPI generator can preserve
// the complete URL hierarchy, including nested routers.
const mountApiRoute = (path: string, router: express.Router) => {
	apiRouter.use(path, router);
	const layer = (apiRouter as express.Router & { stack?: Array<Record<string, unknown>> }).stack?.at(-1);
	if (layer) (layer as unknown as Record<string, unknown>).__swaggerPath = path;
};

// Mount core routes to the API router
mountApiRoute('/auth', authRouter);
mountApiRoute('/profiles', profileRouter);
mountApiRoute('/dashboard', dashboardRouter);
mountApiRoute('/projects', projectRouter);
mountApiRoute('/proposals', proposalRouter);
mountApiRoute('/assistant', aiAssistantRouter);
mountApiRoute('/provider', providerRouter);
mountApiRoute('/chat', chatRouter);
mountApiRoute('/ai-review', aiReviewRouter);
mountApiRoute('/business-models', businessModelsRouter);
mountApiRoute('/marketplace', marketplaceRouter);
mountApiRoute('/notifications', notificationsRouter);
mountApiRoute('/marketer-overview', marketerOverviewRouter);
mountApiRoute('/marketer/profile', marketerProfileRouter);
mountApiRoute('/', cartCheckoutRouter);

import clientFinanceRoutes from './routes/client-finance.routes';
import clientReportsRoutes from './routes/client-reports.routes';
import newsletterRoutes from './routes/newsletter.routes';
import paypalWebhookRoutes from './routes/paypal-webhook.routes';

mountAppRoute('/api/provider/profile', providerProfileRoutes);
mountAppRoute('/api/specialties', specialtyRoutes);
mountAppRoute('/api/provider/specialties', providerSpecialtyRoutes);
mountAppRoute('/api/provider/gamification', gamificationRoutes);
mountAppRoute('/api/provider/logs', accountLogsRoutes);
mountAppRoute('/api/client/profile', clientProfileRoutes);
mountAppRoute('/api/client/requests', clientRequestsRoutes);
mountAppRoute('/client/requests', clientRequestsRoutes);
mountAppRoute('/api/client/my-requests', clientRequestsRoutes);
mountAppRoute('/client/my-requests', clientRequestsRoutes);
mountAppRoute('/api/client/projects', clientProjectAmendmentsRoutes);
mountAppRoute('/client/projects', clientProjectAmendmentsRoutes);
mountAppRoute('/api/client/finance', clientFinanceRoutes);
mountAppRoute('/client/finance', clientFinanceRoutes);
mountAppRoute('/api/client/reports', clientReportsRoutes);
mountAppRoute('/client/reports', clientReportsRoutes);
mountAppRoute('/api/newsletter', newsletterRoutes);
mountAppRoute('/newsletter', newsletterRoutes);

// PayPal Sandbox webhook — public (see routes/paypal-webhook.routes.ts).
// External LIVE/Sandbox webhook URL for DEV, once configured in the PayPal
// Dashboard: https://dev.waseetai.com/api/payments/paypal/webhook
mountAppRoute('/api/payments/paypal', paypalWebhookRoutes);
mountAppRoute('/payments/paypal', paypalWebhookRoutes);

import adminSpecialtiesRouter from './routes/admin-specialties.routes';
import adminUsersRouter from './routes/admin-users.routes';
import aiAssessmentRoutes from './routes/ai-assessment.routes';
import accountManagementRoutes from './routes/account-management.routes';
import adminDisputesRoutes from './routes/admin-disputes.routes';
import adminWithdrawalsRoutes from './routes/admin-withdrawals.routes';
import adminOnboardingRoutes from './routes/admin-onboarding.routes';
import adminAccreditationRoutes from './routes/admin-accreditation.routes';
import adminAffiliateRequestsRoutes from './routes/admin-affiliate-requests.routes';
import adminBrokersRoutes from './routes/admin-brokers.routes';
import adminSecurityRoutes from './routes/admin-security.routes';

// Support BOTH prefixed and unprefixed paths.
// - app.use('/api', apiRouter) handles local development where frontend calls http://localhost:5009/api
// - app.use('/', apiRouter) handles VPS Nginx proxies that automatically strip the /api/ prefix in their proxy_pass
mountAppRoute('/api/user', accountManagementRoutes);
mountAppRoute('/user', accountManagementRoutes);
mountAppRoute('/api/assessments', aiAssessmentRoutes);
mountAppRoute('/assessments', aiAssessmentRoutes);
mountAppRoute('/api/admin/specialties', adminSpecialtiesRouter);
mountAppRoute('/admin/specialties', adminSpecialtiesRouter);
mountAppRoute('/api/admin/users', adminUsersRouter);
mountAppRoute('/admin/users', adminUsersRouter);
mountAppRoute('/api/admin/disputes', adminDisputesRoutes);
mountAppRoute('/admin/disputes', adminDisputesRoutes);
mountAppRoute('/api/admin/withdrawals', adminWithdrawalsRoutes);
mountAppRoute('/admin/withdrawals', adminWithdrawalsRoutes);
mountAppRoute('/api/admin/affiliate-requests', adminAffiliateRequestsRoutes);
mountAppRoute('/admin/affiliate-requests', adminAffiliateRequestsRoutes);
mountAppRoute('/api/admin/onboarding', adminOnboardingRoutes);
mountAppRoute('/admin/onboarding', adminOnboardingRoutes);
mountAppRoute('/api/admin/accreditation', adminAccreditationRoutes);
mountAppRoute('/admin/accreditation', adminAccreditationRoutes);
mountAppRoute('/api/admin/brokers', adminBrokersRoutes);
mountAppRoute('/admin/brokers', adminBrokersRoutes);
mountAppRoute('/api/admin/security', adminSecurityRoutes);
mountAppRoute('/admin/security', adminSecurityRoutes);
mountAppRoute('/api', apiRouter);
mountAppRoute('/', apiRouter);

// Add public redirect route
mountAppRoute('/ref', refRouter);

// ==========================================
// 3.1 API DOCUMENTATION
// ==========================================
// The document is generated after all routers are mounted, so it reflects the
// actual Express application and stays in sync as new endpoints are added.
export const openApiDocument = createOpenApiDocument(app);
app.get('/api/openapi.json', (_req, res) => res.json(openApiDocument));
app.get('/openapi.json', (_req, res) => res.json(openApiDocument));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, {
	customSiteTitle: 'Waseet AI API Documentation'
}));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, {
	customSiteTitle: 'Waseet AI API Documentation'
}));

// Catch-all route for unhandled requests
app.use((req: Request, res: Response, next: NextFunction) => {
	next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

// ==========================================
// 4. GLOBAL ERROR HANDLER
// ==========================================
app.use(globalErrorHandler);

// ==========================================
// 5. SERVER BOOTSTRAP
// ==========================================


const PORT = process.env.PORT || 5009;
const httpServer = createServer(app);

// Initialize Socket.io
export const io = initSocketServer(httpServer, allowedOrigins);

if (process.env.NODE_ENV !== 'test') {
	httpServer.listen(Number(PORT), '0.0.0.0', () => {
		logger.info(`🚀 Server is running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
		logger.info(`👉 http://localhost:${PORT}/api`);
	});
}

export default app;
