import { randomUUID } from 'node:crypto';
import { logger } from '../../../config/logger';
import { getWaseetAiConfig, WASEET_AI_CLIENT_ID, type WaseetAiConfig } from '../../../config/ai/waseet-ai.config';
import { WaseetAiError, WaseetAiErrorCode, errorFromHttpStatus, normalizeWaseetAiError } from './waseet-ai.errors';
import { parseSseStream } from './waseet-ai.sse';
import { readSearchSuggestionsHtml } from './waseet-ai.grounding';
import { currentWaseetActor, WaseetServiceTokenBroker, type WaseetActor } from './waseet-ai.auth';
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
  ProviderMatchingRequest,
  ProviderMatchingResponse,
  AssessmentStatusResponse,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
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
  /** Server-authenticated identity; never copied from a request body. */
  actor?: WaseetActor;
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
  'AI-14': '/v1/ai/project-fit',
  'AI-15': '/v1/ai/marketplace/recommendations',
  'AI-17-bio': '/v1/ai/profile/bio',
  'AI-18': '/v1/ai/project-health',
  'AI-19': '/v1/ai/delivery-review',
  'AI-21-stream': '/v1/ai/help/stream',
  'AI2-01': '/v1/ai/business-models/re-audit',
} as const;
export type UnverifiedEndpointId = keyof typeof UNVERIFIED_ENDPOINTS;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readCitations(raw: unknown[]): WaseetAiCitation[] {
  return raw.slice(0, 20).filter(isObject).filter(c => typeof (c.docId ?? c.documentId) === 'string' && !!(c.docId ?? c.documentId) && typeof c.title === 'string' && !!c.title)
    .map(c => ({ docId: String(c.docId ?? c.documentId).slice(0, 100), title: String(c.title).slice(0, 300),
      ...(typeof (c.url ?? c.sourceUrl) === 'string' && /^https:\/\//.test(String(c.url ?? c.sourceUrl)) ? { url: String(c.url ?? c.sourceUrl).slice(0, 2000) } : {}),
      ...(typeof c.section === 'string' ? { section: c.section.slice(0, 150) } : {}),
      ...(typeof c.line === 'number' && Number.isSafeInteger(c.line) && c.line > 0 ? { line: c.line } : {}),
      ...(typeof c.version === 'string' ? { version: c.version.slice(0, 100) } : {}),
      ...(typeof c.excerpt === 'string' ? { excerpt: c.excerpt.slice(0, 2000) } : {}) }));
}

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
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: controller.signal, clear: () => { clearTimeout(timer); external?.removeEventListener('abort', onAbort); }, abort: () => controller.abort() };
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
const STARTED_EVENTS = new Set(['generation.started', 'help:answer_start', 'start']);
const DELTA_EVENTS = new Set(['text.delta', 'help:answer_chunk', 'chunk']);
const CITATION_EVENTS = new Set(['citations', 'help:citations']);
const COMPLETED_EVENTS = new Set(['generation.completed', 'done', 'help:answer_complete']);
const ERROR_EVENTS = new Set(['error', 'generation.failed', 'help:error']);

export class WaseetAiClient {
  private readonly tokenBroker: WaseetServiceTokenBroker;
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
    private readonly configProvider: () => WaseetAiConfig = () => getWaseetAiConfig(),
  ) { this.tokenBroker = new WaseetServiceTokenBroker(this.fetchImpl); }

  /** True only when WASEET_AI_BEARER_TOKEN is set. Never throws, never
   *  reveals the token. */
  isConfigured(): boolean {
    const c = this.configProvider();
    return c.authMode === 'signed' ? !!c.clientSecret && c.clientSecret.length >= 32 : !!c.bearerToken;
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
      isObject(d) && typeof d.clarityScore === 'number' && Number.isFinite(d.clarityScore) && d.clarityScore >= 0 && d.clarityScore <= 100 &&
      (d.feasibilityScore === null || typeof d.feasibilityScore === 'number' && Number.isFinite(d.feasibilityScore) && d.feasibilityScore >= 0 && d.feasibilityScore <= 100) &&
      typeof d.executiveSummary === 'string',
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

  /** AI2-06 — GET /v1/ai/assessments/:attemptId/status */
  getAssessmentStatus(attemptId: string, opts?: WaseetAiCallOptions): Promise<AssessmentStatusResponse> {
    if (!attemptId || typeof attemptId !== 'string') {
      return Promise.reject(new WaseetAiError(WaseetAiErrorCode.BAD_REQUEST, 'attemptId is required'));
    }
    return this.postJson(`/v1/ai/assessments/${encodeURIComponent(attemptId)}/status`, undefined, opts, (d) =>
      isObject(d) && typeof d.attemptId === 'string' && typeof d.status === 'string',
      'GET'
    );
  }

  /** AI-20 — POST /v1/ai/disputes/summary (routed to the paid/sensitive
   *  project by WaseetAI itself). Callers must minimise PII in claims. */
  summarizeDispute(body: DisputeSummaryRequest, opts?: WaseetAiCallOptions): Promise<DisputeSummaryResponse> {
    return this.postJson('/v1/ai/disputes/summary', body, opts, (d) => isObject(d) && typeof d.summary === 'string');
  }

  searchKnowledge(body: KnowledgeSearchRequest, opts?: WaseetAiCallOptions): Promise<KnowledgeSearchResponse> {
    return this.postJson('/v1/knowledge/search', body, opts, d => isObject(d) &&
      (d.retrievalMode === 'hybrid' || d.retrievalMode === 'lexical') && Array.isArray(d.documents) && d.documents.every(doc =>
        isObject(doc) && ['documentId', 'version', 'title', 'locale', 'content', 'createdAt', 'approvedBy', 'approvedAt']
          .every(key => typeof doc[key] === 'string' && !!doc[key]) && doc.status === 'APPROVED' &&
        ['all', 'client', 'provider', 'admin'].includes(String(doc.audience)) &&
        (doc.ownerId === undefined || typeof doc.ownerId === 'string')));
  }

  /** AI2-04 — POST /v1/ai/avatar/chat. Returns text plus server-synthesized
   *  Arabic speech (base64 mp3) — real AI voice, not browser TTS. */
  async avatarChat(body: AvatarChatRequest, opts?: WaseetAiCallOptions): Promise<AvatarChatResponse> {
    const response = await this.postJson<AvatarChatResponse>('/v1/ai/avatar/chat', body, opts, (d) => {
      if (!isObject(d) || typeof d.text !== 'string') return false;
      // Older deployments attach a lazy TTS URL even to text-only replies.
      // Audio is not part of that request's contract and is never fetched.
      if (body.includeBase64 === false) return true;
      if (d.audio == null) return true;
      return isObject(d.audio) && (typeof d.audio.base64Audio === 'string' || d.audio.status === 'unavailable' || d.audio.status === 'omitted');
    });
    return body.includeBase64 === false ? { text: response.text, audio: { status: 'omitted' } } : response;
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
      Array.isArray(d.suggestedSubSpecialties) && [d.recommendedMinBudget, d.recommendedMaxBudget].every(v => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0) && typeof d.suggestedDurationDays === 'number',
    );
  }

  /** AI-10 — POST /v1/ai/proposals/suggest */
  suggestProposal(body: ProposalSuggestRequest, opts?: WaseetAiCallOptions): Promise<ProposalSuggestResponse> {
    return this.postJson('/v1/ai/proposals/suggest', body, opts, (d) =>
      isObject(d) && typeof d.suggestedTitle === 'string' && typeof d.suggestedMessage === 'string' &&
      typeof d.qualityScore === 'number' && typeof d.qualityTag === 'string' && (d.suggestedAdvantages == null || Array.isArray(d.suggestedAdvantages)),
    );
  }

  /** AI-16 — POST /v1/ai/profile/performance-summary */
  summarizePerformance(body: PerformanceSummaryRequest, opts?: WaseetAiCallOptions): Promise<PerformanceSummaryResponse> {
    const keys = ['executionQuality', 'onTimeDelivery', 'communication', 'clientSatisfaction', 'onTimeCompletionRate', 'repeatClientRate', 'highRatingServicesRate', 'conflictFreeDeliveryRate'];
    return this.postJson('/v1/ai/profile/performance-summary', body, opts, (d) => isObject(d) && keys.every(k => d[k] === null || typeof d[k] === 'number' && Number.isFinite(d[k]) && (d[k] as number) >= 0 && (d[k] as number) <= 100));
  }

  /** AI-17 — POST /v1/ai/profile/skills */
  suggestSkills(body: ProfileSkillsRequest, opts?: WaseetAiCallOptions): Promise<ProfileSkillsResponse> {
    return this.postJson('/v1/ai/profile/skills', body, opts, (d) =>
      isObject(d) && Array.isArray(d.suggestedSkills) && d.suggestedSkills.every((x: unknown) => typeof x === 'string'),
    );
  }

  /** AI-13 — POST /v1/ai/matching/projects-for-provider */
  matchProjectsForProvider(body: ProviderMatchingRequest, opts?: WaseetAiCallOptions): Promise<ProviderMatchingResponse> {
    return this.postJson('/v1/ai/matching/projects-for-provider', body, opts, (d) =>
      isObject(d) && Array.isArray(d.aiMatchingProjects) && isObject(d.summary),
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
      isObject(d) && (d.isApproved === null || typeof d.isApproved === 'boolean') &&
      (d.status === undefined || d.status === 'REQUIRES_HUMAN_REVIEW') &&
      (d.scoreBasis === undefined || d.scoreBasis === 'OFFERING_COMPLETENESS_RUBRIC') &&
      typeof d.score === 'number' && Number.isFinite(d.score) && d.score >= 0 && d.score <= 100 &&
      typeof d.summary === 'string' && d.summary.trim().length > 0 &&
      Array.isArray(d.strengths) && Array.isArray(d.issues) && Array.isArray(d.recommendations) &&
      [d.strengths, d.issues, d.recommendations].every((a: unknown[]) => a.every((x) => typeof x === 'string')),
    );
  }

  /** AI-12 — POST /v1/ai/proposals/enrich */
  enrichProposal(body: EnrichProposalRequest, opts?: WaseetAiCallOptions): Promise<EnrichProposalResponse> {
    return this.postJson('/v1/ai/proposals/enrich', body, opts, (d) =>
      isObject(d) && typeof d.id === 'string' && (typeof d.qualityScore === 'number' || typeof d.aiMatchScore === 'number') && typeof d.aiQualityTag === 'string' &&
      (d.aiPriceTag === null || typeof d.aiPriceTag === 'string') && isObject(d.aiFeedback) && typeof d.aiFeedback.summary === 'string',
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

  getCapabilities(opts?: WaseetAiCallOptions): Promise<Record<string, unknown>> {
    return this.postJson('/v1/ai/capabilities', undefined, opts, (d) => isObject(d) && Array.isArray(d.models) && Array.isArray(d.voices), 'GET');
  }

  transcribe(body: Record<string, unknown>, opts?: WaseetAiCallOptions): Promise<Record<string, unknown>> {
    return this.postJson('/v1/ai/stt/transcribe', body, opts, (d) => isObject(d) && typeof d.text === 'string');
  }

  liveToken(body: Record<string, unknown>, opts?: WaseetAiCallOptions): Promise<Record<string, unknown>> {
    return this.postJson('/v1/ai/live/token', body, opts, (d) => isObject(d) && typeof d.token === 'string' && typeof d.model === 'string');
  }

  generate(body: Record<string, unknown>, opts?: WaseetAiCallOptions): Promise<{ text: string; tokensIn: number | null; tokensOut: number | null; model?: string }> {
    return this.postJson('/v1/ai/gateway/generate', body, opts, (d) => isObject(d) && typeof d.text === 'string' && [d.tokensIn, d.tokensOut].every((v) => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0));
  }

  streamGenerated(body: Record<string, unknown>, opts?: WaseetAiCallOptions): AsyncGenerator<WaseetAiStreamEvent, void, void> {
    return this.postStream('/v1/ai/gateway/stream', body, opts);
  }

  reviewDelivery(body: Record<string, unknown>, opts?: WaseetAiCallOptions): Promise<Record<string, unknown>> {
    return this.postJson('/v1/ai/delivery-review', body, opts, (d) => isObject(d) && typeof d.summary === 'string');
  }

  reviewPortfolio(body: Record<string, unknown>, opts?: WaseetAiCallOptions): Promise<Record<string, unknown>> {
    return this.postJson('/v1/ai/portfolio-review', body, opts, d => isObject(d) && d.status === 'PENDING_REVIEW' && isObject(d.feedback));
  }

  suggestBio(body: Record<string, unknown>, opts?: WaseetAiCallOptions): Promise<Record<string, unknown>> {
    return this.postJson('/v1/ai/profile/bio', body, opts, (d) => isObject(d) && (typeof d.suggestedBio === 'string' || Array.isArray(d.options)));
  }

  createRun(body: Record<string, unknown>, opts?: WaseetAiCallOptions): Promise<Record<string, unknown>> {
    return this.postJson('/v1/ai/runs', body, opts, (d) => isObject(d) && typeof d.runId === 'string');
  }

  runOperation(runId: string, operation: 'status' | 'cancel' | 'resume' | 'events', body: Record<string, unknown> = {}, opts?: WaseetAiCallOptions): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new WaseetAiError(WaseetAiErrorCode.BAD_REQUEST, 'Invalid run id');
    const after = operation === 'events' && body.after !== undefined ? Number(body.after) : 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new WaseetAiError(WaseetAiErrorCode.BAD_REQUEST, 'Invalid event cursor');
    return this.postJson(`/v1/ai/runs/${runId}${operation === 'status' ? '' : '/' + operation}${operation === 'events' ? '?after=' + after : ''}`, body, opts, isObject, operation === 'status' || operation === 'events' ? 'GET' : 'POST');
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

  private async buildRequest(path: string, body: unknown, accept: string, requestId: string, signal: AbortSignal, opts: WaseetAiCallOptions): Promise<{ url: string; init: RequestInit }> {
    const config = this.configProvider();
    if (!this.isConfigured()) {
      throw new WaseetAiError(WaseetAiErrorCode.NOT_CONFIGURED, 'WaseetAI is not configured (WASEET_AI_BEARER_TOKEN missing)', { requestId });
    }
    const actor = opts.actor ?? currentWaseetActor() ?? { userId: 'service-reader', role: 'system' as const };
    const token = await this.tokenBroker.token(config, actor, signal, requestId);
    return {
      url: `${config.baseUrl}${path}`,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: accept,
          'X-Client-Id': config.clientId || WASEET_AI_CLIENT_ID,
          'X-Request-Id': requestId,
        },
        body: JSON.stringify(body ?? {}),
      },
    };
  }

  private async postJson<T>(path: string, body: unknown, opts: WaseetAiCallOptions = {}, validate?: (data: unknown) => boolean, method: 'POST' | 'GET' = 'POST'): Promise<T> {
    const requestId = opts.requestId ?? randomUUID();
    const config = this.configProvider();
    const { signal, clear } = composeSignal(opts.timeoutMs ?? config.restTimeoutMs, opts.signal);
    const startedAt = Date.now();

    try {
      const { url, init } = await this.buildRequest(path, body, 'application/json', requestId, signal, opts);
      init.method = method;
      if (method === 'GET') delete init.body;
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
      const { url, init } = await this.buildRequest(path, body, 'text/event-stream', requestId, signal, opts);
      const response = await this.fetchImpl(url, { ...init, signal });

      if (!response.ok) {
        await response.text().catch(() => undefined);
        throw errorFromHttpStatus(response.status, requestId);
      }
      if (!response.body) {
        throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI stream had no body', { status: response.status, requestId });
      }

      let completed = false;
      let citationsSeen = false;
      let suggestionsSeen = false;
      const loggedUnknown = new Set<string>();
      for await (const evt of parseSseStream(response.body)) {
        const data = isObject(evt.data) ? evt.data : {};
        const name = evt.event;
        if (STARTED_EVENTS.has(name)) {
          yield typeof data.citationsCount === 'number' ? { type: 'started', citationsCount: data.citationsCount } : { type: 'started' };
        } else if (DELTA_EVENTS.has(name)) {
          // A known text event without a string chunk is a malformed event —
          // fail loudly instead of silently dropping part of the answer.
          const chunk = name === 'chunk' ? data.text : data.chunk;
          if (typeof chunk !== 'string') {
            throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI sent a malformed text event', { requestId });
          }
          if (chunk.length > 0) yield { type: 'delta', chunk };
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
          const citations = readCitations(raw);
          const searchSuggestionsHtml = readSearchSuggestionsHtml(data.searchSuggestionsHtml);
          citationsSeen = true;
          if (searchSuggestionsHtml !== undefined) suggestionsSeen = true;
          yield { type: 'citations', citations, ...(searchSuggestionsHtml !== undefined ? { searchSuggestionsHtml } : {}) };
        } else if (name === 'task.progress' || name === 'help:progress' || name === 'run.started' || name === 'task.started') {
          yield { type: 'progress', stage: typeof data.stage === 'string' ? data.stage.slice(0, 60) : name,
            ...(typeof data.runId === 'string' ? { runId: data.runId.slice(0, 100) } : {}),
            ...(typeof data.message === 'string' ? { message: data.message.slice(0, 300) } : {}),
            ...(typeof data.status === 'string' ? { status: data.status.slice(0, 30) } : {}),
          };
        } else if (COMPLETED_EVENTS.has(name)) {
          // Enhancement previews may contain several drafts. A partial provider
          // response must never become an apparently complete selectable preview.
          if (path === '/v1/ai/text/enhance/stream') {
            const finishReason = data.finishReason ?? data.finish_reason;
            if (data.truncated === true || data.partial === true || data.error ||
              (data.status !== undefined && !['completed', 'success', 'succeeded'].includes(String(data.status).toLowerCase())) ||
              (finishReason !== undefined && String(finishReason).toUpperCase() !== 'STOP')) {
              throw new WaseetAiError(WaseetAiErrorCode.INVALID_RESPONSE, 'WaseetAI enhancement response was incomplete', { requestId });
            }
          }
          const searchSuggestionsHtml = readSearchSuggestionsHtml(data.searchSuggestionsHtml);
          if ((!citationsSeen && Array.isArray(data.citations)) || (!suggestionsSeen && searchSuggestionsHtml !== undefined)) {
            yield { type: 'citations', citations: !citationsSeen && Array.isArray(data.citations) ? readCitations(data.citations) : [],
              ...(!suggestionsSeen && searchSuggestionsHtml !== undefined ? { searchSuggestionsHtml } : {}) };
          }
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
