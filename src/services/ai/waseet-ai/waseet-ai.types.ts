// Request/response contracts for WaseetAI endpoints.
//
// ONLY contracts with a worked example in the official WaseetAI Integration
// Guide are typed here. Every other endpoint in the 31-feature matrix is
// listed in UNVERIFIED_ENDPOINTS (waseet-ai.client.ts) and deliberately has
// no invented field names — its shape must be confirmed against the live
// service before a typed method is added.

export type WaseetAiLanguage = 'ar' | 'en';
export type WaseetAiModelTier = 'LIGHT' | 'STANDARD' | 'PRO' | (string & {});

/** Standard REST envelope documented by the guide. */
export interface WaseetAiEnvelope<T> {
  success: boolean;
  data: T;
}

// AI-01 — POST /v1/ai/project-description/stream (SSE)
export interface ProjectDescriptionStreamRequest {
  title: string;
  category: string;
  language: WaseetAiLanguage;
  modelTier?: WaseetAiModelTier;
}

// AI-03 — POST /v1/ai/milestones
export interface MilestonesRequest {
  title: string;
  description: string;
  totalAmount: number;
  currency: string;
}
export interface WaseetAiMilestone {
  title: string;
  description: string;
  days: number;
  percentage: number;
  amount: number;
}
export interface MilestonesResponse {
  milestones: WaseetAiMilestone[];
}

// AI-04 — POST /v1/ai/project-analysis
export interface ProjectAnalysisRequest {
  title: string;
  description: string;
  budget: number;
  deadlineDays: number;
  currency: string;
}
export interface ProjectAnalysisResponse {
  clarityScore: number;
  feasibilityScore: number;
  marketFitRating: number | string;
  executiveSummary: string;
  strengths: string[];
  gapsAndRisks: string[];
}

// AI-08 — POST /v1/ai/assessments
export interface CreateAssessmentRequest {
  providerSpecialtyId: string;
  specialtyName: string;
  questionCount: number;
  timeLimitMinutes: number;
}
export interface WaseetAiAssessmentOption {
  id: string;
  text: string;
}
export interface WaseetAiAssessmentQuestion {
  id: string;
  textAr: string;
  options: WaseetAiAssessmentOption[];
}
export interface CreateAssessmentResponse {
  attemptId: string;
  questions: WaseetAiAssessmentQuestion[];
  timeLimitMinutes: number;
}

// AI2-05 — POST /v1/ai/assessments/:attemptId/submit
export interface SubmitAssessmentRequest {
  submittedAnswers: Record<string, string>;
  timeSpentSeconds: number;
}
export interface SubmitAssessmentResponse {
  attemptId: string;
  score: number;
  isPassed: boolean;
  status: 'COMPLETED' | (string & {});
  feedbackAr: string;
  strengths: string[];
  weaknesses: string[];
}

// AI-20 — POST /v1/ai/disputes/summary (Paid / Sensitive project)
export interface DisputeSummaryRequest {
  disputeId: string;
  projectId: string;
  clientClaim: string;
  providerClaim: string;
  evidenceList: string[];
}
export interface DisputeSummaryResponse {
  summary: string;
  clientPerspective: string;
  providerPerspective: string;
  recommendation: string;
}

// AI-21 — POST /v1/ai/help/chat (SSE, RAG over verified knowledge base)
//
// Verified live (2026-09-30), not just from the guide:
//  - `question` is required (an empty body returns 400 VALIDATION_ERROR).
//  - `history` is accepted and strictly validated upstream as
//    [{ role: 'user' | 'assistant' | 'system', content: string }]. A wrong
//    shape returns 400 with per-field details. We never send 'system'.
//  - Unknown top-level keys (e.g. a `role` field) are silently stripped, so
//    there is NO upstream field for the user's account role.
export type HelpChatHistoryRole = 'user' | 'assistant';
export interface HelpChatHistoryMessage {
  role: HelpChatHistoryRole;
  content: string;
}
export interface HelpChatRequest {
  question: string;
  history?: HelpChatHistoryMessage[];
}
export interface WaseetAiCitation {
  docId: string;
  title: string;
}

// AI2-04 — POST /v1/ai/avatar/chat (text + server-side Arabic speech)
export interface AvatarChatRequest {
  message: string;
}
export interface AvatarChatResponse {
  text: string;
  audio?: {
    mimeType: string; // documented as "audio/mp3"
    base64Audio: string;
  } | null;
}

// POST /v1/ai/tts/synthesize — speech synthesis.
//
// Source: the Bebo v4 handoff (Bebo-Website-Handoff-v4, cute-robot/server.mjs
// `/api/speech` → `remote('/v1/ai/tts/synthesize', …)` and `extractAudio()`),
// whose VERIFICATION.md reports a live HTTP 200 WAV (24 kHz) with this exact
// request body. VERIFIED live from this backend on 2026-09-30 (one call):
// HTTP 200 application/json {success, requestId, data:{audio:{mimeType:
// 'audio/wav', base64Audio, sizeBytes, durationEstimateSec}, metadata:{voice,
// dialect, style, modelUsed, projectAliasUsed, mimeType, sizeBytes,
// durationEstimateSec}}} — audio at data.audio.base64Audio, RIFF/WAVE
// 24 kHz mono 16-bit.
//
// Request body sent by the handoff, field for field.
export interface TtsSynthesizeRequest {
  text: string;
  dialect: string;
  voice: string;
  model: string;
  speakingRate: 'normal';
  mimeType: 'audio/wav';
}
// Response: the handoff reads the audio defensively from several places
// (`data.audio.base64Audio | data.audio.base64 | data.audio.audioUrl |
// data.audio.url | data.audioUrl` as a `data:audio/wav;base64,` URL), i.e.
// the exact response field is NOT pinned down by the handoff — the client
// accepts exactly those same locations and nothing else.

/** Normalized, transport-agnostic events yielded by the client's streaming
 *  helpers. Gateways relay these to Socket.IO (or SSE) without ever seeing
 *  the raw upstream wire format. */
export type WaseetAiStreamEvent =
  | { type: 'started'; citationsCount?: number }
  | { type: 'question'; attemptId: string; question: WaseetAiStreamedQuestion }
  | { type: 'assessment_ready'; attemptId: string; totalQuestions: number; timeLimitMinutes: number; generationSource?: string }
  | { type: 'delta'; chunk: string }
  | { type: 'citations'; citations: WaseetAiCitation[] }
  | { type: 'completed' }
  | { type: 'unknown'; event: string; data: unknown };

// ── Contracts verified live on 2026-10-02 (synthetic data only) ─────────────
// Sources: the vendor test lab (WaseetAI-Frontend/app.js) for request fields
// and response rendering, the service's own VALIDATION_ERROR details for the
// required fields, and one limited live call per endpoint for the response
// shape. Optional request fields not listed here are NOT known; unknown
// top-level keys are stripped upstream, so never send extras.

/** POST /v1/ai/request-draft — every field optional; {} still answers. */
export interface RequestDraftRequest {
  title?: string;
  description?: string;
  specialtyName?: string;
  currency?: string;
}
export interface RequestDraftResponse {
  suggestedTitle: string;
  suggestedDescription: string;
  suggestedSubSpecialties: string[];
  recommendedMinBudget: number;
  recommendedMaxBudget: number;
  suggestedDurationDays: number;
  complexityRating: string;
  personalizedNote: string;
  aiMatchScoreEstimate: number;
}

/** POST /v1/ai/proposals/suggest — projectId is an opaque string; the service
 *  has no access to Waseet's project data, so `priceAudit` is NOT grounded in
 *  the real project budget and must not be shown as such. */
export interface ProposalSuggestRequest {
  projectId: string;
  currentTitle: string;
  currentMessage: string;
  currency?: string;
}
export interface ProposalSuggestResponse {
  suggestedTitle: string;
  suggestedMessage: string;
  qualityScore: number;
  qualityTag: string;
  priceAudit?: { recommendedMin: number; recommendedMax: number; priceTag: string; justification: string };
  suggestedAdvantages: string[];
}

/** POST /v1/ai/profile/performance-summary — computed from the counts sent. */
export interface PerformanceSummaryRequest {
  providerId: string;
  totalProjectsCompleted: number;
  onTimeProjectsCount: number;
  repeatClientsCount: number;
  totalClientsCount: number;
  fiveStarReviewsCount: number;
  totalReviewsCount: number;
  disputedProjectsCount: number;
}
export interface PerformanceSummaryResponse {
  executionQuality: number;
  onTimeDelivery: number;
  communication: number;
  clientSatisfaction: number;
  onTimeCompletionRate: number;
  repeatClientRate: number;
  highRatingServicesRate: number;
  conflictFreeDeliveryRate: number;
}

/** POST /v1/ai/profile/skills — specialtyName drives the output. */
export interface ProfileSkillsRequest {
  providerId: string;
  specialtyName: string;
}
export interface ProfileSkillsResponse {
  suggestedSkills: string[];
}

/** POST /v1/ai/text/suggest/stream (SSE text.delta / generation.completed). */
export interface TextSuggestStreamRequest {
  title: string;
}
/** POST /v1/ai/text/enhance/stream (SSE text.delta / generation.completed). */
export interface TextEnhanceStreamRequest {
  description: string;
}

/** POST /v1/ai/assessments/stream (SSE question.streamed x N, then
 *  assessment.ready). specialtyName and questionCount are honoured (verified:
 *  output changed with them); providerSpecialtyId is the only required field.
 *  Answer keys are never sent; grading is POST /assessments/:attemptId/submit. */
export interface AssessmentStreamRequest {
  providerSpecialtyId: string;
  specialtyName?: string;
  questionCount?: number;
  timeLimitMinutes?: number;
}
export interface WaseetAiStreamedQuestion {
  id: number;
  textAr: string;
  options: Array<{ id: string; text: string }>;
}
