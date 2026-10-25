import { adminMayUseRemoteAi } from '../admin-access.service';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { mapHelpAssistantRole } from '../../sockets/help-assistant-auth';
import { waseetAiClient, type WaseetAiClient } from './waseet-ai/waseet-ai.client';
import { normalizeWaseetAiError, WaseetAiErrorCode } from './waseet-ai/waseet-ai.errors';

const liveSchema = z.object({ model: z.literal('gemini-3.8-live').optional(),
  voice: z.enum(['Puck', 'Kore', 'Fenrir', 'Aoede', 'Zephyr', 'Sulafat', 'Charon', 'Leda']).optional(),
  language: z.enum(['ar-EG', 'ar', 'en']).optional() }).strict();
const sttSchema = z.object({ audioBase64: z.string().min(8).max(8_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  mimeType: z.enum(['audio/webm', 'audio/webm;codecs=opus', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/ogg;codecs=opus', 'audio/flac']),
  languageCodes: z.array(z.enum(['ar-EG', 'ar', 'en', 'en-US'])).max(3).optional(),
  mode: z.enum(['smart', 'verbatim']).optional(), timestamps: z.boolean().optional(), diarization: z.boolean().optional(),
  customVocabulary: z.array(z.string().min(1).max(100)).max(50).optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.mode === 'smart' || v.customVocabulary?.length) && (v.timestamps || v.diarization)) ctx.addIssue({ code: 'custom', message: 'Incompatible transcription options' });
  if (Buffer.from(v.audioBase64, 'base64').length > 6_000_000) ctx.addIssue({ code: 'custom', message: 'Audio exceeds size limit' });
});

export interface AssistantToolsDeps {
  client?: Pick<WaseetAiClient, 'getCapabilities' | 'transcribe' | 'liveToken' | 'createRun' | 'runOperation'>;
  isBlocked?: (id: string) => Promise<boolean>;
}

export function createAssistantToolsHandlers(deps: AssistantToolsDeps = {}) {
  const client = deps.client || waseetAiClient;
  const blocked = deps.isBlocked || (async (id: string) => { const u = await prisma.user.findUnique({ where: { id }, select: { isBanned: true } }); return !u || u.isBanned; });
  const handler = (operation: 'capabilities' | 'stt' | 'live' | 'run' | 'status' | 'cancel' | 'resume' | 'events') => async (req: Request, res: Response) => {
    const user = req.user;
    const userId = user?.id || user?.userId;
    const role = mapHelpAssistantRole(user?.activeRole, user?.accountType);
    if (!userId || !role) { res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'يجب تسجيل الدخول لاستخدام المساعد.' }); return; }
    if (role === 'admin' && !(await adminMayUseRemoteAi(userId))) { res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'هذه الميزة غير متاحة للحساب.' }); return; } // remote AI is SUPER_ADMIN-only for administrators
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    const opts = { signal: controller.signal, actor: { userId, role }, timeoutMs: 60_000 };
    try {
      if (await blocked(userId)) { res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'هذه الميزة غير متاحة للحساب.' }); return; }
      let result: Record<string, unknown>;
      if (operation === 'capabilities') result = await client.getCapabilities(opts);
      else if (operation === 'stt') {
        const parsed = sttSchema.safeParse(req.body);
        if (!parsed.success) { res.status(400).json({ success: false, code: 'INVALID_INPUT', message: 'ملف الصوت أو إعدادات التفريغ غير صالحة.' }); return; }
        const mimeType = parsed.data.mimeType === 'audio/mp4' ? 'audio/m4a' : parsed.data.mimeType.split(';')[0];
        result = await client.transcribe({ ...parsed.data, mimeType, classification: 'PERSONAL' }, opts);
      } else if (operation === 'live') {
        const parsed = liveSchema.safeParse(req.body || {});
        if (!parsed.success) { res.status(400).json({ success: false, code: 'INVALID_INPUT', message: 'إعدادات المحادثة الصوتية غير صالحة.' }); return; }
        result = await client.liveToken({ ...parsed.data, classification: 'PERSONAL' }, opts);
      } else if (operation === 'run') {
        const parsed = z.object({ question: z.string().trim().min(1).max(6000), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(), model: z.string().regex(/^gemini-[A-Za-z0-9.-]{1,80}$/).optional() }).strict().safeParse(req.body);
        if (!parsed.success) { res.status(400).json({ success: false, code: 'INVALID_INPUT', message: 'طلب المهمة غير صالح.' }); return; }
        result = await client.createRun({ ...parsed.data, classification: 'PERSONAL' }, opts);
      } else {
        // Authorization of ownership is enforced again by the actor-bound AI service token.
        const query = z.object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict().safeParse(req.query);
        if (!query.success) { res.status(400).json({ success: false, code: 'INVALID_INPUT', message: 'مؤشر أحداث المهمة غير صالح.' }); return; }
        result = await client.runOperation(String(req.params.runId), operation, operation === 'events' ? { after: query.data.after ?? 0 } : {}, opts);
      }
      if (!controller.signal.aborted) res.set('Cache-Control', 'no-store').json({ success: true, data: result });
    } catch (error) {
      if (controller.signal.aborted) return;
      const e = normalizeWaseetAiError(error);
      const status = e.code === WaseetAiErrorCode.BAD_REQUEST ? 400 : e.code === WaseetAiErrorCode.AUTHENTICATION_ERROR ? 403
        : e.code === WaseetAiErrorCode.NOT_FOUND ? 404 : e.code === WaseetAiErrorCode.RATE_LIMITED ? 429 : e.code === WaseetAiErrorCode.TIMEOUT ? 504 : 503;
      res.status(status).json({ success: false, code: e.code, message: 'تعذر إكمال طلب المساعد حالياً. يمكنك المحاولة لاحقاً.' });
    } finally { res.off('close', abort); }
  };
  return { capabilities: handler('capabilities'), stt: handler('stt'), live: handler('live'), run: handler('run'),
    status: handler('status'), cancel: handler('cancel'), resume: handler('resume'), events: handler('events') };
}
