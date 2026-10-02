import { randomUUID } from 'node:crypto';
import { logger } from '../../../config/logger';
import { getWaseetAiConfig, WASEET_AI_CLIENT_ID, type WaseetAiConfig } from '../../../config/ai/waseet-ai.config';
import { WaseetAiError, WaseetAiErrorCode, errorFromHttpStatus, normalizeWaseetAiError } from './waseet-ai.errors';
import { parseSseStream } from './waseet-ai.sse';
import type {
  AvatarChatRequest,
  AvatarChatResponse,
  CreateAssessmentRequest,
  CreateAssessmentResponse,
  DisputeSummaryRequest,
  DisputeSummaryResponse,
  HelpChatRequest,
  AssessmentStreamRequest,
  BusinessModelAuditRequest,
  BusinessModelAuditResponse,
  EnrichProposalRequest,
  EnrichProposalResponse,
  MilestonesRequest,
  MilestonesResponse,
  PerformanceSummaryRequest,
  PerformanceSummaryResponse,
  ProfileSkillsRequest,
  ProfileSkillsResponse,
  ProposalSuggestRequest,
  ProposalSuggestResponse,
  RequestDraftRequest,
  RequestDraftResponse,
  TextEnhanceStreamRequest,
  TextSuggestStreamRequest,
  ProjectAnalysisRequest,
  ProjectAnalysisResponse,
  ProjectDescriptionStreamRequest,
  SubmitAssessmentRequest,
  SubmitAssessmentResponse,
  TtsSynthesizeRequest,
  WaseetAiCitation,
  WaseetAiStreamEvent,
} from './waseet-ai.types';

// Centralized WaseetAI microservice client — the ONLY module in the backend
// allowed to hold the WaseetAI bearer token or issue HTTP calls to the
// WaseetAI service. Architecture:
//
//   Angular  ──(JWT, REST / Socket.IO)──▶  Waseet backend feature service
//            ──▶ waseetAiClient (this file, bearer token from env) ──▶ WaseetAI
//
// Like geminiClient, it contains NO product logic (no prompts, no fallback
// text, no fake results). It returns typed data or throws a WaseetAiError.
// Feature services decide how to surface failures truthfully to users.
//
// Status: REST connectivity proven live (milestones smoke test). AI-21 help
// streaming is the first live feature wired to this client
// (sockets/help-assistant-chat.gateway.ts); its SSE framing was probed live
// — see the event-name notes above postStream's mapping.
// Also live through this client (request/response mapping in
// waseet-ai.adapters.ts, existing Angular contracts unchanged):
//  - AI-01 project description stream (generate mode) — ai-assistant.gateway.ts
//  - AI-03 milestones, AI-04 project analysis — modules/ai-review/ai-review.service.ts
//  - TTS — services/ai/help-assistant-tts.ts

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface WaseetAiCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Propagate an existing trace id; otherwise a UUID is generated. */
  requestId?: string;
}

/** Matrix endpoints whose contract is NOT verified. (Moved out once verified
 *  live on 2026-10-02: AI-02, AI-05, AI-10, AI-16, AI-17 skills, AI2-07,
 *  AI2-10 — see the typed methods below.) Several remaining ones were probed
 *  and are unusable as-is: they take only opaque ids, the service cannot see
 *  Waseet's data, and some answer with constant sample data.
 *  Calling them throws CONTRACT_UNVERIFIED until verified live. */
export const UNVERIFIED_ENDPOINTS = {
  'AI-06': '/v1/ai/portfolio-review',
  'AI-07': '/v1/ai/accreditation-review',
  'AI-09': '/v1/ai/onboarding-quizzes',
  'AI-11': '/v1/ai/proposals/audit/stream',
  'AI-13': '/v1/ai/matching/projects-for-provider',
  'AI-14': '/v1/ai/project-fit',
  'AI-15': '/v1/ai/marketplace/recommendations',
  'AI-17-bio': '/v1/ai/profile/bio',
  'AI-18': '/v1/ai/project-health',
  'AI-19': '/v1/ai/delivery-review',
  'AI-21-stream': '/v1/ai/help/stream',
  'AI2-01': '/v1/ai/business-models/re-audit',
  'AI2-06': '/v1/ai/assessments/:id/status',
} as const;
export type UnverifiedEndpointId = keyof typeof UNVERIFIED_ENDPOINTS;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Upper bound on the base64 audio accepted from upstream (handoff value). */
export const MAX_TTS_BASE64_LENGTH = 18_000_000;
const WAV_DATA_URL_PREFIX = 'data:audio/wav;base64,';

/**
 * Extracts WAV bytes from a /v1/ai/tts/synthesize `data` payload using
 * exactly the locations and checks of the Bebo v4 handoff's
 * `extractAudio()` (server.mjs): base64 in `audio.base64Audio` /
 * `audio.base64`, or a `data:audio/wav;base64,` URL in `audio.audioUrl` /
 * `audio.url` / `audioUrl`; 60..18,000,000 base64 chars; a RIFF/WAVE header.
 * Returns null for anything else — never guesses another field.
 */
export function extractTtsWav(data: unknown): Buffer | null {
  if (!isObject(data)) return null;
  const audio = isObject(data.audio) ? data.audio : {};
  let encoded: unknown = audio.base64Audio ?? audio.base64;
  const dataUrl = audio.audioUrl ?? audio.url ?? data.audioUrl;
  if (!encoded && typeof dataUrl === 'string' && dataUrl.startsWith(WAV_DATA_URL_PREFIX)) encoded = dataUrl.slice(WAV_DATA_URL_PREFIX.length);
  if (typeof encoded !== 'string' || encoded.length < 60 || encoded.length > MAX_TTS_BASE64_LENGTH || !/^[A-Za-z0-9+/=\s]+$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  return bytes;
}

function composeSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; clear: () => void; abort: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer), abort: () => controller.abort() };
}

// SSE event names, per endpoint family.
//
// AI-01 (project description) uses the names documented in the guide.
// AI-21 (help) was probed live on 2026-09-30 and does NOT use the guide's
// names: the real stream opens with `event: help:answer_start`
// (data {status:"started", citationsCount}) and, when no approved
// knowledge-base policy matches, ends with `event: help:error`
// (data {message, human_support_fallback:true}). Those two are VERIFIED.
// No successful help answer could be observed (the upstream knowledge base
// returned 0 citations for every probe), so `help:answer_chunk` /
// `help:answer_complete` / `help:citations` are INFERRED from the verified
// `help:*` naming and accepted alongside the guide's documented
// `text.delta` / `generation.completed` / `citations`. Any other event name
// is surfaced as `unknown` and logged by NAME ONLY so the real success-path
// contract shows up in logs the first time it happens.
const STARTED_EVENTS = new Set(['generation.started', 'help:answer_start']);
const DELTA_EVENTS = new Set(['text.delta', 'help:answer_chunk']);
const CITATION_EVENTS = new Set(['citations', 'help:citations']);
const COMPLETED_EVENTS = new Set(['generation.completed', 'done', 'help:answer_complete']);
const ERROR_EVENTS = new Set(['error', 'generation.failed', 'help:error']);

export class WaseetAiClient {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
    private readonly configProvider: () => WaseetAiConfig = () => getWaseetAiConfig(),
  ) {}

  /** True only when WASEET_AI_BEARER_TOKEN is set. Never throws, never
   *  reveals the token. */
  isConfigured(): boolean {
    return !!this.configProvider().bearerToken;
  }

  /** Base URL in use (not a secret) — useful for health/diagnostic output. */
  getBaseUrl(): string {
    return this.configProvider().baseUrl;
  }

  // ── Documented REST endpoints ─────────────────────────────────────────

  /** AI-03 — POST /v1/ai/milestones */
  suggestMilestones(body: MilestonesRequest, opts?: WaseetAiCallOptions): Promise<MilestonesResponse> {
    return this.postJson('/v1/ai/milestones', body, opts, (d) => isObject(d) && Array.isArray(d.milestones));
  }

  /** AI-04 — POST /v1/ai/project-analysis */
  analyzeProject(body: ProjectAnalysisRequest, opts?: WaseetAiCallOptions): Promise<ProjectAnalysisResponse> {
    return this.postJson('/v1/ai/project-analysis', body, opts, (d) =>
      isObject(d) && typeof d.clarityScore === 'number' && typeof d.feasibilityScore === 'number' && typeof d.executiveSummary === 'string',
    );
  }

  /** AI-08 — POST /v1/ai/assessments. Answer key stays server-side. */
  createAssessment(body: CreateAssessmentRequest, opts?: WaseetAiCallOptions): Promise<CreateAssessmentResponse> {
    return this.postJson('/v1/ai/assessments', body, opts, (d) => isObject(d) && typeof d.attemptId === 'string' && Array.isArray(d.questions));
  }

  /** AI2-05 — POST /v1/ai/assessments/:attemptId/submit */
  submitAssessment(attemptId: string, body: SubmitAssessmentRequest, opts?: WaseetAiCallOptions): Promise<SubmitAssessmentResponse> {
    if (!attemptId || typeof attemptId !== 'string') {
      return Promise.reject(new WaseetAiError(WaseetAiErrorCode.BAD_REQUEST, 'attemptId is required'));
    }
    return this.postJson(`/v1/ai/assessments/${encodeURIComponent(attemptId)}/submit`, body, opts, (d) =>
      isObject(d) && typeof d.score === 'number' && typeof d.isPassed === 'boolean',
    );
  }

  /** AI-20 — POST /v1/ai/disputes/summary (routed to the paid/sensitive
   *  project by WaseetAI itself). Callers must minimise PII in claims. */
  summarizeDispute(body: DisputeSummaryRequest, opts?: WaseetAiCallOptions): Promise<DisputeSummaryResponse> {
    return this.postJson('/v1/ai/disputes/summary', body, opts, (d) => isObject(d) && typeof d.summary === 'string');
  }

  /** AI2-04 — POST /v1/ai/avatar/chat. Returns text plus server-synthesized
   *  Arabic speech (base64 mp3) — real AI voice, not browser TTS. */
  avatarChat(body: AvatarChatRequest, opts?: WaseetAiCallOptions): Promise<AvatarChatResponse> {
    return this.postJson('/v1/ai/avatar/chat', body, opts, (d) => {
      if (!isObject(d) || typeof d.text !== 'string') return false;
      if (d.audio == null) return true;
      return isObject(d.audio) && typeof d.audio.base64Audio === 'string';
    });
  }

  /** POST /v1/ai/tts/synthesize — returns the synthesized speech as WAV
   *  bytes. Contract taken from the Bebo v4 handoff (see
   *  TtsSynthesizeRequest); any response that does not carry a valid WAV in
   *  one of the handoff's accepted locations is INVALID_RESPONSE. */
  async synthesizeSpeech(body: TtsSynthesizeRequest, opts?: WaseetAiCallOptions): Promise<Buffer> {
    const data = await this.postJson<unknown>('/v1/ai/tts/synthesize', body, opts, (d) => extractTtsWav(d) !== null);
    // Validated above; re-extract to get the bytes (cheap, pure).
    return extractTtsWav(data) as Buffer;
  }

  // ── Verified live 2026-10-02 (synthetic data) ──────────────────────

  /** AI-02 — POST /v1/ai/request-draft */
  requestDraft(body: RequestDraftRequest, opts?: WaseetAiCallOptions): Promise<RequestDraftResponse> {
    return this.postJson('/v1/ai/request-draft', body, opts, (d) =>
      isObject(d) && typeof d.suggestedTitle === 'string' && typeof d.suggestedDescription === 'string' &&
      Array.isArray(d.suggestedSubSpecialties) && typeof d.recommendedMinBudget === 'number' &&
      typeof d.recommendedMaxBudget === 'number' && typeof d.suggestedDurationDays === 'number',
    );
  }

  /** AI-10 — POST /v1/ai/proposals/suggest */
  suggestProposal(body: ProposalSuggestRequest, opts?: WaseetAiCallOptions): Promise<ProposalSuggestResponse> {
    return this.postJson('/v1/ai/proposals/suggest', body, opts, (d) =>
      isObject(d) && typeof d.suggestedTitle === 'string' && typeof d.suggestedMessage === 'string' &&
      typeof d.qualityScore === 'number' && typeof d.qualityTag === 'string' && Array.isArray(d.suggestedAdvantages),
    );
  }

  /** AI-16 — POST /v1/ai/profile/performance-summary */
  summarizePerformance(body: PerformanceSummaryRequest, opts?: WaseetAiCallOptions): Promise<PerformanceSummaryResponse> {
    const keys = ['executionQuality', 'onTimeDelivery', 'communication', 'clientSatisfaction', 'onTimeCompletionRate', 'repeatClientRate', 'highRatingServicesRate', 'conflictFreeDeliveryRate'];
    return this.postJson('/v1/ai/profile/performance-summary', body, opts, (d) => isObject(d) && keys.every((k) => typeof d[k] === 'number'));
  }

  /** AI-17 — POST /v1/ai/profile/skills */
  suggestSkills(body: ProfileSkillsRequest, opts?: WaseetAiCallOptions): Promise<ProfileSkillsResponse> {
    return this.postJson('/v1/ai/profile/skills', body, opts, (d) =>
      isObject(d) && Array.isArray(d.suggestedSkills) && d.suggestedSkills.every((x: unknown) => typeof x === 'string'),
    );
  }

  /** AI-05 — POST /v1/ai/text/suggest/stream (SSE) */
  streamTextSuggestion(body: TextSuggestStreamRequest, opts?: WaseetAiCallOptions): AsyncGenerator<WaseetAiStreamEvent, void, void> {
    return this.postStream('/v1/ai/text/suggest/stream', body, opts);
  }

  /** AI2-10 — POST /v1/ai/text/enhance/stream (SSE) */
  streamTextEnhancement(body: TextEnhanceStreamRequest, opts?: WaseetAiCallOptions): AsyncGenerator<WaseetAiStreamEvent, void, void> {
    return this.postStream('/v1/ai/text/enhance/stream', body, opts);
  }

  /** AI2-07 — POST /v1/ai/assessments/stream (SSE: question + assessment_ready) */
  streamAssessmentQuestions(body: AssessmentStreamRequest, opts?: WaseetAiCallOptions): AsyncGenerator<WaseetAiStreamEvent, void, void> {
    return this.postStream('/v1/ai/assessments/stream', body, opts);
  }

  /** AI2-02 — POST /v1/ai/business-models/audit (advisory verdict) */
  auditBusinessModel(body: BusinessModelAuditRequest, opts?: WaseetAiCallOptions): Promise<BusinessModelAuditResponse> {
    return this.postJson('/v1/ai/business-models/audit', body, opts, (d) =>
      isObject(d) && typeof d.isApproved === 'boolean' && typeof d.score === 'number' && d.score >= 0 && d.score <= 100 &&
      typeof d.summary === 'string' && d.summary.trim().length > 0 &&
      Array.isArray(d.strengths) && Array.isArray(d.issues) && Array.isArray(d.recommendations) &&
      [d.strengths, d.issues, d.recommendations].every((a: unknown[]) => a.every((x) => typeof x === 'string')),
    );
  }

  /** AI-12 — POST /v1/ai/proposals/enrich */
  enrichProposal(body: EnrichProposalRequest, opts?: WaseetAiCallOptions): Promise<EnrichProposalResponse> {
    return this.postJson('/v1/ai/proposals/enrich', body, opts, (d) =>
      isObject(d) && typeof d.id === 'string' && typeof d.aiMatchScore === 'number' && typeof d.aiQualityTag === 'string' &&
      typeof d.aiPriceTag === 'string' && isObject(d.aiFeedback) && typeof d.aiFeedback.summary === 'string',
    );
  }

  // ── Documented SSE endpoints ──────────────────────────────────────────

  /** AI-01 — POST /v1/ai/project-description/stream */
  streamProjectDescription(body: ProjectDescriptionStreamRequest, opts?: WaseetAiCallOptions): AsyncGenerator<WaseetAiStreamEvent, void, void> {
    return this.postStream('/v1/ai/project-description/stream', body, opts);
  }

  /** AI-21 — POST /v1/ai/help/chat (RAG). Body {question, history?}.
   *  In-stream `help:error` (e.g. no approved policy found) is thrown as a
   *  STREAM_ERROR WaseetAiError carrying `humanSupportFallback`. */
  streamHelpChat(body: HelpChatRequest, opts?: WaseetAiCallOptions): AsyncGenerator<WaseetAiStreamEvent, void, void> {
    return this.postStream('/v1/ai/help/chat', body, opts);
  }

  // ── Undocumented contracts ────────────────────────────────────────────

  /** Placeholder for matrix endpoints without a documented contract. Always
   *  throws CONTRACT_UNVERIFIED — it never makes a network call and never
   *  guesses field names. Replace with a typed method once verified live. */
  async callUnverified(id: UnverifiedEndpointId): Promise<never> {
    // TODO(waseet-ai): verify contract live, then add a typed method.
    throw new WaseetAiError(
      WaseetAiErrorCode.CONTRACT_UNVERIFIED,
      `WaseetAI endpoint ${id} (${UNVERIFIED_ENDPOINTS[id]}) has no verified request/response contract yet`,
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private buildRequest(path: string, body: unknown, accept: string, requestId: string): { url: string; init: RequestInit } {
    const config = this.configProvider();
    if (!config.bearerToken) {
      throw new WaseetAiError(WaseetAiErrorCode.NOT_CONFIGURED, 'WaseetAI is not configured (WASEET_AI_BEARER_TOKEN missing)', { requestId });
    }
    return {
      url: `${config.baseUrl}${path}`,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.bearerToken}`,
          'Content-Type': 'application/json',
          Accept: accept,
          'X-Client-Id': WASEET_AI_CLIENT_ID,
          'X-Request-Id': requestId,
        },
        body: JSON.stringify(body ?? {}),
      },
    };
  }

  private async postJson<T>(path: string, body: unknown, opts: WaseetAiCallOptions = {}, validate?: (data: unknown) => boolean): Promise<T> {
    const requestId = opts.requestId ?? randomUUID();
    const config = this.configProvider();
    const { signal, clear } = composeSignal(opts.timeoutMs ?? config.restTimeoutMs, opts.signal);
    const startedAt = Date.now();

    try {
      const { url, init } = this.buildRequest(path, body, 'application/json', requestId);
      const response = await this.fetchImpl(url, { ...init, signal });

      if (!response.ok) {
        // Drain the body so the socket can be reused; never surface it.
        await response.text().catch(() => undefined);
        throw errorFromHttpStatus(response.status, requestId);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (e) {
        throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI returned malformed JSON', { status: response.status, requestId, cause: e });
      }

      if (!isObject(parsed) || parsed.success !== true || !('data' in parsed)) {
        throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI returned an unsuccessful or malformed envelope', { status: response.status, requestId });
      }
      if (validate && !validate(parsed.data)) {
        throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI response failed contract validation', { status: response.status, requestId });
      }

      logger.debug(`[WaseetAiClient] POST ${path} ok requestId=${requestId} ms=${Date.now() - startedAt}`);
      return parsed.data as T;
    } catch (error) {
      const normalized = normalizeWaseetAiError(error, requestId);
      logger.debug(`[WaseetAiClient] POST ${path} failed code=${normalized.code} status=${normalized.status ?? '-'} requestId=${requestId}`);
      throw normalized;
    } finally {
      clear();
    }
  }

  private async *postStream(path: string, body: unknown, opts: WaseetAiCallOptions = {}): AsyncGenerator<WaseetAiStreamEvent, void, void> {
    const requestId = opts.requestId ?? randomUUID();
    const config = this.configProvider();
    const { signal, clear, abort } = composeSignal(opts.timeoutMs ?? config.streamTimeoutMs, opts.signal);

    try {
      const { url, init } = this.buildRequest(path, body, 'text/event-stream', requestId);
      const response = await this.fetchImpl(url, { ...init, signal });

      if (!response.ok) {
        await response.text().catch(() => undefined);
        throw errorFromHttpStatus(response.status, requestId);
      }
      if (!response.body) {
        throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI stream had no body', { status: response.status, requestId });
      }

      let completed = false;
      const loggedUnknown = new Set<string>();
      for await (const evt of parseSseStream(response.body)) {
        const data = isObject(evt.data) ? evt.data : {};
        const name = evt.event;
        if (STARTED_EVENTS.has(name)) {
          yield typeof data.citationsCount === 'number' ? { type: 'started', citationsCount: data.citationsCount } : { type: 'started' };
        } else if (DELTA_EVENTS.has(name)) {
          // A known text event without a string chunk is a malformed event —
          // fail loudly instead of silently dropping part of the answer.
          if (typeof data.chunk !== 'string') {
            throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI sent a malformed text event', { requestId });
          }
          if (data.chunk.length > 0) yield { type: 'delta', chunk: data.chunk };
        } else if (name === 'question.streamed') {
          const q = isObject(data.question) ? data.question : null;
          if (
            typeof data.attemptId !== 'string' || !q || typeof q.id !== 'number' || typeof q.textAr !== 'string' ||
            !Array.isArray(q.options) || !q.options.every((o: unknown) => isObject(o) && typeof o.id === 'string' && typeof o.text === 'string')
          ) {
            throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI sent a malformed question event', { requestId });
          }
          yield {
            type: 'question',
            attemptId: data.attemptId,
            question: { id: q.id, textAr: q.textAr, options: (q.options as Array<{ id: string; text: string }>).map((o) => ({ id: o.id, text: o.text })) },
          };
        } else if (name === 'assessment.ready') {
          if (typeof data.attemptId !== 'string' || typeof data.totalQuestions !== 'number' || typeof data.timeLimitMinutes !== 'number') {
            throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI sent a malformed assessment.ready event', { requestId });
          }
          completed = true;
          yield {
            type: 'assessment_ready',
            attemptId: data.attemptId,
            totalQuestions: data.totalQuestions,
            timeLimitMinutes: data.timeLimitMinutes,
            ...(typeof data.generationSource === 'string' ? { generationSource: data.generationSource } : {}),
          };
          yield { type: 'completed' };
        } else if (CITATION_EVENTS.has(name)) {
          const raw = Array.isArray(evt.data) ? evt.data : Array.isArray(data.citations) ? data.citations : [];
          const citations: WaseetAiCitation[] = raw
            .filter((c: unknown): c is Record<string, unknown> => isObject(c))
            .map((c: Record<string, unknown>) => ({ docId: String(c.docId ?? ''), title: String(c.title ?? '') }));
          yield { type: 'citations', citations };
        } else if (COMPLETED_EVENTS.has(name)) {
          completed = true;
          yield { type: 'completed' };
        } else if (ERROR_EVENTS.has(name)) {
          // The upstream message text is deliberately NOT copied — only the
          // boolean handoff flag (verified field name: human_support_fallback).
          const humanSupportFallback = data.human_support_fallback === true || data.humanSupportFallback === true;
          throw new WaseetAiError(WaseetAiErrorCode.STREAM_ERROR, 'WaseetAI reported an in-stream error', { requestId, humanSupportFallback });
        } else {
          if (!loggedUnknown.has(name)) {
            loggedUnknown.add(name);
            logger.warn(`[WaseetAiClient] STREAM ${path} unrecognized event name="${name.slice(0, 64)}" requestId=${requestId}`);
          }
          yield { type: 'unknown', event: name, data: evt.data };
        }
        if (completed) break;
      }

      if (!completed) {
        throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI stream ended without a completion event', { requestId });
      }
    } catch (error) {
      const normalized = normalizeWaseetAiError(error, requestId);
      logger.debug(`[WaseetAiClient] STREAM ${path} failed code=${normalized.code} status=${normalized.status ?? '-'} requestId=${requestId}`);
      throw normalized;
    } finally {
      clear();
      // Also runs when the consumer stops iterating early (disconnect,
      // cancel, completion): abort so the upstream HTTP body is released
      // instead of being left open until the service closes it.
      abort();
    }
  }
}

export const waseetAiClient = new WaseetAiClient();
