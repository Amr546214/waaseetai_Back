import { Socket } from 'socket.io';
import { AccountType } from '@prisma/client';
import { prisma } from '../config/db';
import { waseetAiClient, type WaseetAiClient } from '../services/ai/waseet-ai/waseet-ai.client';
import { normalizeWaseetAiError } from '../services/ai/waseet-ai/waseet-ai.errors';
import { canRewrite, checkRewriteOutput, REWRITE_INPUT_REQUIRED_MESSAGE } from '../utils/description-rewrite-guard';
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
// REWRITE ONLY: the client writes the title and a real description first; the AI only restates that text. There is no generate-from-scratch mode:
// an empty/too-short title or description is refused before any AI call, with nothing written into the form. The text goes to WaseetAI
// POST /v1/ai/text/enhance/stream with {description: <draft>} only (that endpoint takes nothing else, its prompt is the vendor's), the reply is buffered,
// and it is relayed as WaseetAI wrote it (assistant phrasing/markdown are accepted by owner decision). Only an empty reply is refused and an over-long one is cut
// to 2000 (checkRewriteOutput). On refusal or failure the client gets an honest error and keeps the original text. Events relayed to the Create Request page:
// ai:description_start / ai:description_chunk (the reply) / ai:description_complete / ai:description_error.
//
// Not available (no WaseetAI contract, no fallback): the AI title/specialty pre-check, and AI rewriting of the title (the title is never changed by AI).
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
      const draft = payload?.existingDescription?.trim() || '';

      if (!canRewrite(title, draft)) {
        socket.emit('ai:description_error', {
          code: 'INSUFFICIENT_INPUT',
          message: REWRITE_INPUT_REQUIRED_MESSAGE
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

      const mode = 'refine' as const;
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

        const callOpts = { signal: abortController.signal, timeoutMs: 45 * 1000 };
        const stream = this.waseetAi.streamTextEnhancement({ description: draft }, callOpts);
        for await (const evt of stream) {
          if (abortController.signal.aborted) break;
          if (evt.type === 'delta') fullStreamedText += evt.chunk;
          else if (evt.type === 'completed') break;
        }
        if (abortController.signal.aborted) throw new Error('aborted');

        const checked = checkRewriteOutput(draft, fullStreamedText);
        if (checked.ok) {
          socket.emit('ai:description_chunk', { chunk: checked.text, mode });
          socket.emit('ai:description_complete', {
            fullText: checked.text,
            mode,
            status: 'success',
            message: 'تمت إعادة صياغة وصفك، راجعها قبل اعتمادها'
          });
          return;
        }
        console.error(`[AiAssistantGateway] rewrite reply refused reason=${checked.reason}`);
        socket.emit('ai:description_error', {
          code: 'AI_OUTPUT_REJECTED',
          message: 'لم تُرجع خدمة الصياغة نصًا، فبقي وصفك كما كتبته. حاول مرة أخرى.'
        });
        return;
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
        message: 'تعذرت إعادة الصياغة من خدمة الذكاء الاصطناعي، وبقي وصفك كما كتبته. حاول مرة أخرى.'
      });
    });
  }
}

export const aiAssistantGateway = new AiAssistantGateway();
export const registerAiAssistantGateway = (socket: Socket) => aiAssistantGateway.register(socket);
