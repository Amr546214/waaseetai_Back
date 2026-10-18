import { Router, type RequestHandler } from 'express';
import { prisma } from '../config/db';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { aiLimiter } from '../middlewares/rate-limit.middleware';
import { waseetAiClient } from '../services/ai/waseet-ai/waseet-ai.client';
import { createHelpAssistantTtsHandler, createUserRateLimiter, type HelpAssistantTtsDeps } from '../services/ai/help-assistant-tts';
import { createAssistantToolsHandlers } from '../services/ai/help-assistant-tools';
import { createAssistantHttpHandler } from '../services/ai/help-assistant-http';

// POST /api/help-assistant/tts — Help Assistant / Bebo speech (WaseetAI TTS).
// Available to every authenticated, active dashboard role (the same
// audience as the help-assistant socket), so it deliberately does NOT live
// under /assistant, whose router is provider-only.
//
// Guard chain: authenticate (verified JWT + live session) → requireActiveUser
// → aiLimiter (per-IP, shared with every other AI route) → handler (role
// mapping, ban check, per-user limit, fail-closed config check).

export interface HelpAssistantTtsRouterOptions extends Partial<HelpAssistantTtsDeps> {
	/** Test seam; production always uses the real guard chain below. */
	guards?: RequestHandler[];
}

export function createHelpAssistantTtsRouter(options: HelpAssistantTtsRouterOptions = {}): Router {
	const router = Router();
	const guards = options.guards ?? [authenticate, requireActiveUser, aiLimiter];
	const handler = createHelpAssistantTtsHandler({
		client: options.client ?? waseetAiClient,
		isBlocked:
			options.isBlocked ??
			(async (userId) => {
				const user = await prisma.user.findUnique({ where: { id: userId }, select: { isBanned: true } });
				return !user || user.isBanned === true;
			}),
		isRateLimited: options.isRateLimited ?? createUserRateLimiter(),
	});
	router.post('/tts', ...guards, handler);
	router.post('/chat', ...guards, createAssistantHttpHandler());
	const tools = createAssistantToolsHandlers();
	router.get('/capabilities', ...guards, tools.capabilities);
	router.post('/stt', ...guards, tools.stt);
	router.post('/live-token', ...guards, tools.live);
	router.post('/runs', ...guards, tools.run);
	router.get('/runs/:runId', ...guards, tools.status);
	router.get('/runs/:runId/events', ...guards, tools.events);
	router.post('/runs/:runId/cancel', ...guards, tools.cancel);
	router.post('/runs/:runId/resume', ...guards, tools.resume);
	return router;
}

export default createHelpAssistantTtsRouter();
