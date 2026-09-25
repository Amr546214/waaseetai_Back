import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/db';
import { geminiClient } from '../services/ai/gemini/gemini.client';
import { isOpenAiTtsConfigured, generateSpeechMp3Base64 } from '../services/ai/openai-tts.client';
import { isSocketAiRateLimited, SOCKET_AI_RATE_LIMIT_MESSAGE } from '../utils/socket-ai-rate-limit';

// F8-TEXT — 3D avatar assistant chat, migrated to the shared Gemini
// foundation (previously embedded inline in socket.ts's `ai_chat` handler,
// calling OpenAI gpt-4o-mini directly with zero rate limiting, no
// cancellation, and always emitting `success: true` — even a total provider
// failure returned a canned greeting disguised as a real response). Text
// generation only — TTS (F8-TTS) remains on OpenAI tts-1-hd in this batch;
// see the Gemini migration report for why (no locally-verifiable contract
// for Gemini's raw audio output format without a live provider call).
//
// This socket path has no live frontend caller today (the RobotAvatar
// component that targets it is built but never mounted in any route — see
// the migration report's caller graph) but remains network-reachable, so
// it is hardened the same as any other AI-cost-bearing socket event.

const MAX_MESSAGE_LENGTH = 1000;

const BODY_LANGUAGE_POSES = ['WELCOME_OPEN', 'ANALYTICAL_THINKING', 'INSTRUCTIVE_DIRECTING', 'CELEBRATORY_JUMP', 'EMPATHETIC_SOFT'] as const;
type BodyLanguagePose = typeof BODY_LANGUAGE_POSES[number];

export interface AvatarSpeechSegment {
  textSegment: string;
  excitementLevel: number;
  gestureFrequency: number;
  bodyLanguagePose: BodyLanguagePose;
}

export interface AvatarChatResponse {
  fullResponse: string;
  speechTimeline: AvatarSpeechSegment[];
}

const AVATAR_CHAT_SCHEMA = {
  type: 'object',
  properties: {
    fullResponse: { type: 'string', description: 'النص الكامل والنهائي المتناسق الذي سيتم نطقه بصوت بشري' },
    speechTimeline: {
      type: 'array',
      description: 'تقسيم الكلام إلى مقاطع متزامنة مع حركات الأفاتار الـ 3D',
      items: {
        type: 'object',
        properties: {
          textSegment: { type: 'string' },
          excitementLevel: { type: 'number', description: '0.0 to 1.0' },
          gestureFrequency: { type: 'number', description: '0.0 to 1.0' },
          bodyLanguagePose: { type: 'string', enum: [...BODY_LANGUAGE_POSES] }
        },
        required: ['textSegment', 'excitementLevel', 'gestureFrequency', 'bodyLanguagePose']
      }
    }
  },
  required: ['fullResponse', 'speechTimeline']
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isUnitInterval = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

// Rejects anything that doesn't genuinely satisfy the avatar speech
// contract — missing text, an out-of-range excitement/gesture value, or an
// unrecognized pose are all invalid, never silently patched with a
// placeholder.
function isValidAvatarChatResponse(value: unknown): value is AvatarChatResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!isNonEmptyString(v.fullResponse)) return false;
  if (!Array.isArray(v.speechTimeline) || v.speechTimeline.length === 0) return false;

  return v.speechTimeline.every((segment) => {
    if (!segment || typeof segment !== 'object') return false;
    const s = segment as Record<string, unknown>;
    if (!isNonEmptyString(s.textSegment)) return false;
    if (!isUnitInterval(s.excitementLevel)) return false;
    if (!isUnitInterval(s.gestureFrequency)) return false;
    if (typeof s.bodyLanguagePose !== 'string' || !(BODY_LANGUAGE_POSES as readonly string[]).includes(s.bodyLanguagePose)) return false;
    return true;
  });
}

const COMMON_PROMPT = `You are the Waseet AI 3D guide. Break your response into chronological segments inside speechTimeline.
Assign 'bodyLanguagePose' from ["WELCOME_OPEN", "ANALYTICAL_THINKING", "INSTRUCTIVE_DIRECTING", "CELEBRATORY_JUMP", "EMPATHETIC_SOFT"].
Set 'excitementLevel' and 'gestureFrequency' (0.0 to 1.0) to control the dynamic kinetic engine.`;

function buildGuestSystemPrompt(): string {
  return `أنت مساعد الذكاء الاصطناعي "وسيط AI". \nالمستخدم الحالي هو زائر غير مسجل (Guest).\nمهمتك هي شرح دور منصة وسيط AI بوضوح (منصة عمل حر تضمن حقوق الطرفين).\nشجعه على التسجيل بطريقة مرحبة، احترافية، ومبسطة جداً.\nاستخدم لغة عربية فصحى ومبسطة، وإجابات قصيرة ومباشرة.\n\n${COMMON_PROMPT}`;
}

function buildAuthenticatedSystemPrompt(user: { firstName: string; lastName: string; accountType: string }): string {
  const isClient = user.accountType === 'CLIENT_INDIVIDUAL' || user.accountType === 'CLIENT_COMPANY';
  return `أنت مساعد الذكاء الاصطناعي "وسيط AI". \nالمستخدم الحالي مسجل الدخول واسمه: ${user.firstName} ${user.lastName}. \nنوع حسابه: ${user.accountType}.\nيجب أن ترحب به باسمه.\nكن ودوداً، احترافياً، وقدم إجابات مختصرة ومباشرة تتناسب مع كونه ${isClient ? 'طالب خدمة' : 'مقدم خدمة'}.\n\n${COMMON_PROMPT}`;
}

export class AvatarChatGateway {
  public register(socket: Socket): void {
    socket.on('ai_chat', async (data: any) => {
      const rawMessage = typeof data?.message === 'string' ? data.message.trim() : '';
      const message = (rawMessage || 'مرحباً').slice(0, MAX_MESSAGE_LENGTH);
      const token = typeof data?.token === 'string' ? data.token : undefined;

      let userId: string | null = (socket as any).userId || null;
      if (token && !userId && process.env.JWT_SECRET) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET) as any;
          userId = decoded.userId || decoded.id || null;
        } catch {
          // Invalid/expired token — treat as guest, same as before.
        }
      }

      // Soft-auth by design (guest visitors get a marketing-oriented
      // assistant instead of being rejected) — but still rate-limited per
      // identity to prevent unlimited-cost abuse. Guests are keyed by
      // socket.id since they have no stable identity.
      const rateLimitKey = userId || `guest:${socket.id}`;
      if (isSocketAiRateLimited(rateLimitKey)) {
        socket.emit('ai_chat_response', {
          success: false,
          status: 'RATE_LIMITED',
          message: SOCKET_AI_RATE_LIMIT_MESSAGE
        });
        return;
      }

      // Registered before the DB lookup so a disconnect during either the
      // lookup or the Gemini call itself is honored — not just a disconnect
      // that happens to land after both have already started.
      const abortController = new AbortController();
      const onDisconnect = () => abortController.abort();
      socket.once('disconnect', onDisconnect);

      let systemPrompt: string | null = null;
      if (userId) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { firstName: true, lastName: true, accountType: true }
        });
        if (user) {
          systemPrompt = buildAuthenticatedSystemPrompt(user);
        }
        // A stale/deleted-user token falls through to the guest prompt below
        // instead of silently sending Gemini an empty system instruction.
      }
      if (!systemPrompt) {
        systemPrompt = buildGuestSystemPrompt();
      }

      let textResponse: string;
      let speechTimeline: AvatarSpeechSegment[];
      try {
        const result = await geminiClient.generateStructured<AvatarChatResponse>(message, {
          systemInstruction: systemPrompt,
          responseSchema: AVATAR_CHAT_SCHEMA,
          validate: isValidAvatarChatResponse,
          temperature: 0.7,
          maxOutputTokens: 500,
          signal: abortController.signal
        });
        textResponse = result.data.fullResponse;
        speechTimeline = result.data.speechTimeline;
      } catch (geminiError: any) {
        socket.off('disconnect', onDisconnect);
        console.warn('[AvatarChatGateway] Gemini generation failed:', geminiError?.code || geminiError?.message);
        // Honest failure — no canned greeting disguised as a real response.
        socket.emit('ai_chat_response', {
          success: false,
          status: 'UNAVAILABLE',
          message: 'تعذر توليد رد المساعد الذكي حالياً، يرجى المحاولة لاحقاً.'
        });
        return;
      }

      // TTS (F8-TTS) — NOT migrated in this batch, see the Gemini migration
      // report. A TTS failure never fails an already-successful text
      // response; it only means no audio is returned this turn.
      let audioBase64: string | null = null;
      let status: 'TEXT_GENERATED' | 'TEXT_GENERATED_AUDIO_UNAVAILABLE' = 'TEXT_GENERATED_AUDIO_UNAVAILABLE';
      if (isOpenAiTtsConfigured()) {
        try {
          audioBase64 = await generateSpeechMp3Base64(textResponse);
          status = 'TEXT_GENERATED';
        } catch (ttsError: any) {
          console.warn('[AvatarChatGateway] TTS generation failed, returning text-only:', ttsError?.message);
        }
      }

      socket.off('disconnect', onDisconnect);
      socket.emit('ai_chat_response', {
        success: true,
        status,
        data: { text: textResponse, speechTimeline, audioBase64 }
      });
    });
  }
}

export const avatarChatGateway = new AvatarChatGateway();
export const registerAvatarChatGateway = (socket: Socket) => avatarChatGateway.register(socket);
