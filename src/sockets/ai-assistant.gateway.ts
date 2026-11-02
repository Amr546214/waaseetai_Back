import { Socket } from 'socket.io';
import { AccountType } from '@prisma/client';
import { prisma } from '../config/db';
import { waseetAiClient, type WaseetAiClient } from '../services/ai/waseet-ai/waseet-ai.client';
import { normalizeWaseetAiError, WaseetAiError, WaseetAiErrorCode } from '../services/ai/waseet-ai/waseet-ai.errors';
import { canRewrite, checkRewritePreview, REWRITE_INPUT_REQUIRED_MESSAGE, REWRITE_MAX_CHARS, REWRITE_PREVIEW_MAX_CHARS } from '../utils/description-rewrite-guard';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';
import { checkMultipleContentPolicy } from '../utils/content-policy-guard';

export interface GenerateDescriptionDto {
  projectTitle: string;
  specialtyId?: string;
  specialtyName?: string;
  subSpecialties?: string[];
  existingDescription?: string;
}

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

      const policy = checkMultipleContentPolicy([title, draft, payload?.specialtyName]);
      if (policy.blocked) {
        socket.emit('ai:description_error', {
          code: 'INSUFFICIENT_INPUT',
          message: policy.reasonAr || 'المحتوى المدخل يخالف سياسات منصة وسيط.'
        });
        return;
      }

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
      let completed = false;

      const abortController = new AbortController();
      const onDisconnect = () => abortController.abort();
      socket.once('disconnect', onDisconnect);

      try {
        socket.emit('ai:description_start', { mode, title });

        const callOpts = { signal: abortController.signal, timeoutMs: 45 * 1000 };
        const stream = this.waseetAi.streamTextEnhancement({ description: draft }, callOpts);
        for await (const evt of stream) {
          if (abortController.signal.aborted) break;
          if (evt.type === 'delta') {
            if (fullStreamedText.length + evt.chunk.length > REWRITE_PREVIEW_MAX_CHARS) {
              abortController.abort();
              socket.emit('ai:description_error', {
                code: 'AI_OUTPUT_TOO_LONG',
                message: 'تجاوزت معاينة الصياغة الحد المسموح. لم تُعتمد صياغة ناقصة، وبقي وصفك كما كتبته. حاول مرة أخرى.',
                partial: true, truncated: true,
                ...(fullStreamedText ? { partialText: fullStreamedText } : {}),
              });
              return;
            }
            fullStreamedText += evt.chunk;
          } else if (evt.type === 'completed') {
            completed = true;
            break;
          }
        }
        if (abortController.signal.aborted) throw new Error('aborted');
        if (!completed) throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'Rewrite stream did not complete');

        const checked = checkRewritePreview(draft, fullStreamedText);
        if (checked.ok) {
          socket.emit('ai:description_chunk', { chunk: checked.text, mode });
          socket.emit('ai:description_complete', {
            fullText: checked.text,
            mode,
            status: 'success',
            message: 'تمت إعادة صياغة وصفك، راجعها قبل اعتمادها',
            truncated: false,
            previewMaxChars: REWRITE_PREVIEW_MAX_CHARS,
            descriptionMaxChars: REWRITE_MAX_CHARS,
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
        message: 'تعذرت إعادة الصياغة من خدمة الذكاء الاصطناعي، وبقي وصفك كما كتبته. حاول مرة أخرى.',
        partial: fullStreamedText.length > 0,
        truncated: fullStreamedText.length > 0,
        ...(fullStreamedText ? { partialText: fullStreamedText } : {}),
      });
    });
  }
}

export const aiAssistantGateway = new AiAssistantGateway();
export const registerAiAssistantGateway = (socket: Socket) => aiAssistantGateway.register(socket);
