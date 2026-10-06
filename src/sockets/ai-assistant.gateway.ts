import { Socket } from 'socket.io';
import { AccountType } from '@prisma/client';
import { prisma } from '../config/db';
import { waseetAiClient, type WaseetAiClient } from '../services/ai/waseet-ai/waseet-ai.client';
import { normalizeWaseetAiError } from '../services/ai/waseet-ai/waseet-ai.errors';
import { buildProjectDescriptionRequest } from '../services/ai/waseet-ai/waseet-ai.adapters';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';

export interface GenerateDescriptionDto {
  projectTitle: string;
  specialtyId?: string;
  specialtyName?: string;
  subSpecialties?: string[];
  existingDescription?: string;
}

// Client-request description generation — a WaseetAI-linked feature, served by WaseetAI (no internal LlmClient, no fallback).
//
// Security note (Batch: F1+F2 streaming, section 7 review): this handler
// previously had NO authentication check at all — the main Socket.IO
// namespace (see socket.ts) does best-effort soft-auth (a valid token sets
// `socket.userId`, but a connection with no/invalid token is still accepted
// anonymously), so an entirely unauthenticated socket could trigger a full
// two-stage Gemini call (validation + streamed generation) in a loop with
// zero cost control. Fixed here with the same `userId` gate already used by
// the sibling ai-review.gateway.ts, plus the same shared per-user rate
// limiter (see socket-ai-rate-limit.ts) — no new framework, just applying
// the existing pattern to the handler that was missing it.
//
// Phase 3 Batch 2A fix: the only current UI caller of this event is the
// client-facing "Create Request" page (client-overview/create-request,
// guarded by clientGuard) — confirmed by tracing every emit site in the
// frontend. The handler now enforces that same role at the socket layer
// instead of accepting any authenticated account type.
//
// WaseetAI integration (AI-01): generate-from-scratch mode now streams from
// WaseetAI POST /v1/ai/project-description/stream (documented v1.0.0 SSE
// contract) via the shared WaseetAiClient, bridged to the SAME Socket.IO
// events the Create Request page already listens to (ai:description_chunk /
// ai:description_complete / ai:description_error) — the same SSE→socket
// relay pattern as help-assistant-chat.gateway.ts. The browser never sees
// the WaseetAI URL, credential or raw SSE frames.
//
// Refine mode (existing draft > 5 chars) streams from WaseetAI
// POST /v1/ai/text/enhance/stream with {description: <draft>} only, and emits
// the same events with mode 'refine'.
//
// Not available (no WaseetAI contract, no fallback):
//  - the AI title/specialty pre-check: WaseetAI documents no equivalent
//    endpoint. Only the deterministic input check (isMeaningfulProjectTitle)
//    remains.
export class AiAssistantGateway {
  constructor(private readonly waseetAi: WaseetAiClient = waseetAiClient) {}

  /**
   * Register Socket.IO listeners for real-time description generation and refinement
   */
  public register(socket: Socket): void {
    socket.on('ai:generate_description', async (payload: GenerateDescriptionDto) => {
      console.log(`🤖 [AiAssistantGateway] Received ai:generate_description from socket ${socket.id} for title: "${payload?.projectTitle}"`);

      const userId = (socket as any).userId;
      if (!userId) {
        socket.emit('ai:description_error', {
          code: 'UNAUTHENTICATED',
          message: 'يجب تسجيل الدخول لاستخدام مولّد الوصف الذكي.'
        });
        return;
      }

      const requester = await prisma.user.findUnique({
        where: { id: userId },
        select: { activeRole: true, accountType: true }
      });
      const isAdminAccount =
        requester?.accountType === AccountType.ADMIN ||
        requester?.accountType === AccountType.SUPER_ADMIN;
      if (!requester || isAdminAccount || requester.activeRole !== 'CLIENT') {
        socket.emit('ai:description_error', {
          code: 'FORBIDDEN_ROLE',
          message: 'هذه الميزة متاحة فقط لحسابات العملاء.'
        });
        return;
      }

      const title = payload?.projectTitle?.trim() || '';
      const specialty = payload?.specialtyName || payload?.specialtyId || 'خدمات الأعمال والتقنية';
      const subSpecialties = Array.isArray(payload?.subSpecialties)
        ? payload.subSpecialties.map(item => String(item).trim()).filter(Boolean).slice(0, 5)
        : [];
      const draft = payload?.existingDescription?.trim() || '';

      if (!this.isMeaningfulProjectTitle(title)) {
        socket.emit('ai:description_error', {
          code: 'TITLE_TOO_VAGUE',
          message: 'العنوان عام أو غير واضح. اكتب عنواناً يحدد الخدمة والهدف قبل طلب الصياغة.'
        });
        return;
      }

      if (isSocketAiRateLimited(userId)) {
        socket.emit('ai:description_error', {
          code: 'RATE_LIMITED',
          message: SOCKET_AI_RATE_LIMIT_MESSAGE
        });
        return;
      }

      // A non-empty draft (> 5 chars) means REFINE: the draft is sent to the
      // verified WaseetAI enhance stream. That endpoint takes ONLY the
      // description, so the title / specialty / sub-specialties cannot be
      // sent (never invented as extra fields). Otherwise GENERATE.
      const mode: 'generate' | 'refine' = draft.length > 5 ? 'refine' : 'generate';
      if (!this.waseetAi.isConfigured()) {
        console.error('[AiAssistantGateway] AI generation rejected: WaseetAI not configured.');
        socket.emit('ai:description_error', {
          code: 'AI_NOT_CONFIGURED',
          message: 'خدمة الذكاء الاصطناعي غير مهيأة حالياً. لم يتم إنشاء أي نص بديل.'
        });
        return;
      }
      let fullStreamedText = '';

      const abortController = new AbortController();
      const onDisconnect = () => abortController.abort();
      socket.once('disconnect', onDisconnect);

      try {
        socket.emit('ai:description_start', { mode, title });

        // AI-01 → WaseetAI SSE, relayed chunk-by-chunk to the socket.
        const callOpts = { signal: abortController.signal, timeoutMs: 45 * 1000 };
        const stream = mode === 'refine'
          ? this.waseetAi.streamTextEnhancement({ description: draft }, callOpts)
          : this.waseetAi.streamProjectDescription(buildProjectDescriptionRequest({ title, specialty, subSpecialties }), callOpts);
        for await (const evt of stream) {
          if (abortController.signal.aborted) break;
          if (evt.type === 'delta') {
            fullStreamedText += evt.chunk;
            // Only the plain string chunk — never a raw upstream object.
            socket.emit('ai:description_chunk', { chunk: evt.chunk, mode });
          } else if (evt.type === 'completed') break;
        }
        if (abortController.signal.aborted) throw new Error('aborted');

        if (fullStreamedText.trim().length > 0) {
          socket.emit('ai:description_complete', {
            fullText: fullStreamedText,
            mode,
            status: 'success',
            message: '✨ تم توليد الوصف الشامل بنجاح'
          });
          return;
        }
      } catch (error: any) {
        // Code/status/requestId only — never upstream text or the token.
        const e = normalizeWaseetAiError(error);
        console.error(`[AiAssistantGateway] WaseetAI generation failed code=${e.code} status=${e.status ?? '-'} requestId=${e.requestId ?? '-'}`);
      } finally {
        socket.off('disconnect', onDisconnect);
      }

      // Honest failure — no substitute description, no canned generated
      // text of any kind.
      socket.emit('ai:description_error', {
        code: 'AI_GENERATION_FAILED',
        message: 'تعذر توليد الوصف من خدمة الذكاء الاصطناعي. لم يتم إنشاء نص افتراضي؛ حاول مرة أخرى.'
      });
    });
  }

  private isMeaningfulProjectTitle(title: string): boolean {
    const normalized = title.replace(/[\p{P}\p{S}_]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const genericTitles = new Set([
      'تجربة', 'اختبار', 'مشروع', 'مشروع جديد', 'طلب', 'طلب جديد', 'خدمة', 'خدمة جديدة',
      'test', 'testing', 'project', 'new project', 'request', 'service'
    ]);
    const words = normalized.split(' ').filter(word => word.length > 1);
    return normalized.length >= 8 && words.length >= 2 && !genericTitles.has(normalized.toLowerCase());
  }
}

export const aiAssistantGateway = new AiAssistantGateway();
export const registerAiAssistantGateway = (socket: Socket) => aiAssistantGateway.register(socket);
