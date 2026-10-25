import { adminHasAnyAccess } from '../admin-access.service';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { mapHelpAssistantRole } from '../../sockets/help-assistant-auth';
import { resolveAssistantOptions, assistantOptionsSchema, resolveAssistantMode, isGreetingIntent, assistantGreetingResponse } from './assistant-request';
import { scrubFreeText } from '../llm/llm.payload';
import { waseetAiClient, type WaseetAiClient } from './waseet-ai/waseet-ai.client';
import { readSearchSuggestionsHtml } from './waseet-ai/waseet-ai.grounding';
import { normalizeWaseetAiError, WaseetAiErrorCode } from './waseet-ai/waseet-ai.errors';
import type { WaseetAiCitation } from './waseet-ai/waseet-ai.types';
import { streamAssistantAnswer } from './assistant-answer';

const bodySchema = assistantOptionsSchema.extend({
  message: z.string().trim().min(1).max(500),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }).strict()).max(12).optional(),
  previousDialect: z.enum(['egyptian', 'saudi', 'gulf', 'msa', 'english']).optional(),
}).strict();

/** Authenticated companion transport. Service credentials stay on the server. */
export function createAssistantHttpHandler(deps: {
  client?: Pick<WaseetAiClient, 'streamHelpChat'> & Partial<Pick<WaseetAiClient, 'avatarChat'>>;
  isBlocked?: (id: string) => Promise<boolean>;
  resolveOptions?: typeof resolveAssistantOptions;
} = {}) {
  const client = deps.client ?? waseetAiClient;
  const blocked = deps.isBlocked ?? (async (id: string) => {
    const user = await prisma.user.findUnique({ where: { id }, select: { isBanned: true } });
    return !user || user.isBanned;
  });
  return async (req: Request, res: Response): Promise<void> => {
    const userId = req.user?.id || req.user?.userId;
    const role = mapHelpAssistantRole(req.user?.activeRole, req.user?.accountType);
    if (!userId || !role) { res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'سجّل الدخول لاستخدام مساعد وسيط.' }); return; }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, code: 'INVALID_INPUT', message: 'رسالة المساعد أو إعداداتها غير صالحة.' }); return; }
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onClose);
    try {
      if (role === 'admin' && !(await adminHasAnyAccess(userId))) { res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'المساعد غير متاح لهذا الحساب.' }); return; }
      if (await blocked(userId)) { res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'المساعد غير متاح لهذا الحساب.' }); return; }
      const options = await (deps.resolveOptions ?? resolveAssistantOptions)(parsed.data, userId, role);
      if (controller.signal.aborted) return;
      options.mode = resolveAssistantMode(parsed.data.message, options.mode);
      if (isGreetingIntent(parsed.data.message)) {
        res.set('Cache-Control', 'no-store').json({ success: true, data: {
          reply: assistantGreetingResponse(options), citations: [], dialect: options.dialect || (options.language === 'en' ? 'english' : 'egyptian'),
        } });
        return;
      }
      const citations: WaseetAiCitation[] = [];
      let searchSuggestionsHtml: string | undefined;
      let reply = '';
      for await (const event of streamAssistantAnswer({ ...options, question: scrubFreeText(parsed.data.message),
        ...(parsed.data.history ? { history: parsed.data.history.map(h => ({ role: h.role, content: scrubFreeText(h.content) })) } : {}) },
        { actor: { userId, role }, signal: controller.signal, timeoutMs: 60_000 }, client)) {
        if (controller.signal.aborted) return;
        if (event.type === 'delta') {
          reply += event.chunk;
          if (reply.length > 24_000) throw new Error('RESPONSE_TOO_LONG');
        } else if (event.type === 'citations') {
          citations.push(...event.citations.slice(0, 20 - citations.length));
          const html = readSearchSuggestionsHtml(event.searchSuggestionsHtml);
          if (html !== undefined) searchSuggestionsHtml = html;
        } else if (event.type === 'completed') break;
      }
      if (!reply.trim()) throw new Error('EMPTY_RESPONSE');
      if (!controller.signal.aborted) res.set('Cache-Control', 'no-store').json({ success: true,
        data: { reply, citations, dialect: options.dialect || 'egyptian',
          ...(searchSuggestionsHtml !== undefined ? { searchSuggestionsHtml } : {}) } });
    } catch (error) {
      if (controller.signal.aborted) return;
      const e = normalizeWaseetAiError(error);
      const denied = (error as { code?: string }).code === 'FORBIDDEN';
      res.status(denied ? 403 : e.code === WaseetAiErrorCode.RATE_LIMITED ? 429 : e.code === WaseetAiErrorCode.TIMEOUT ? 504 : 503)
        .json({ success: false, code: denied ? 'FORBIDDEN' : e.code, message: 'تعذر الرد حالياً. حاول لاحقاً أو تواصل مع الدعم.', humanSupportFallback: true });
    } finally { res.off('close', onClose); }
  };
}
