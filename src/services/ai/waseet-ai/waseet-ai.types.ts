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
  deliveryDays?: number;
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
  feasibilityScore: number | null;
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
  id: string | number;
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
  skin?: 'scout' | 'classic';
  mode?: 'policy' | 'general';
  webSearch?: boolean;
  history?: HelpChatHistoryMessage[];
  dialect?: 'egyptian' | 'saudi' | 'gulf' | 'msa' | 'english';
  language?: 'ar' | 'ar-EG' | 'en';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  profile?: 'fast' | 'balanced' | 'deep' | 'auto';
  model?: string;
  pageContext?: { path: string; project?: { id: string; title: string; description: string; requirements: string[]; status: string }; role?: string };
}
export interface WaseetAiCitation {
  docId: string;
  title: string;
  url?: string;
  section?: string;
  line?: number;
  version?: string;
  excerpt?: string;
}

// AI2-04 — POST /v1/ai/avatar/chat (text + server-side Arabic speech)
export interface AvatarChatRequest {
  message: string;
  locale?: 'ar' | 'en';
  includeBase64?: boolean;
}
export interface AvatarChatResponse {
  text: string;
  audio?: {
    status?: 'available' | 'unavailable' | 'omitted';
    mimeType?: string;
    base64Audio?: string;
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
  | { type: 'citations'; citations: WaseetAiCitation[]; searchSuggestionsHtml?: string }
  | { type: 'progress'; runId?: string; stage: string; message?: string; status?: string }
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
  subSpecialties?: string[];
  availableSkills?: string[];
  deliveryDays?: number | null;
  currency?: string;
}
export interface RequestDraftResponse {
  suggestedTitle: string;
  suggestedDescription: string;
  suggestedSubSpecialties: string[];
  suggestedRequiredSkills?: string[];
  suggestedRequirements?: string[];
  suggestedOutputs?: string;
  suggestedMilestones?: Array<{ name: string; pct: number }>;
  recommendedMinBudget: number | null;
  recommendedMaxBudget: number | null;
  suggestedDurationDays: number;
  complexityRating: string;
  personalizedNote: string;
  aiMatchScoreEstimate: number | null;
}

/** POST /v1/ai/proposals/suggest — projectId is an opaque string; the service
 *  has no access to Waseet's project data, so `priceAudit` is NOT grounded in
 *  the real project budget and must not be shown as such. */
export interface ProposalSuggestRequest {
  projectId: string;
  currentTitle: string;
  currentMessage: string;
  currency?: string;
  project?: {
    budgetMin?: number;
    budgetMax?: number;
    deliveryDays?: number;
    title?: string;
    description?: string;
    requirements?: string[];
  };
}
export interface ProposalSuggestResponse {
  suggestedTitle: string;
  suggestedMessage: string;
  suggestedOutputs?: string;
  suggestedTotalPrice?: number | null;
  suggestedMilestones?: Array<{ name: string; desc: string; days: number; pct: number }>;
  qualityScore: number;
  qualityTag: string;
  priceAudit?: { recommendedMin: number | null; recommendedMax: number | null; priceTag: string | null; justification: string };
  suggestedAdvantages?: string[];
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
  executionQuality: number | null;
  onTimeDelivery: number | null;
  communication: number | null;
  clientSatisfaction: number | null;
  onTimeCompletionRate: number | null;
  repeatClientRate: number | null;
  highRatingServicesRate: number | null;
  conflictFreeDeliveryRate: number | null;
}

/** POST /v1/ai/profile/skills — specialtyName drives the output. */
export interface ProfileSkillsRequest {
  providerId: string;
  specialtyName: string;
  /** Verified 2026-10-02: accepted (array of strings); these are left out of the suggestions. */
  existingSkills?: string[];
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

/** POST /v1/ai/business-models/audit — required: title, description,
 *  pricing.amount. `category` (string) is a schema key verified 2026-10-02:
 *  without it the service guesses a category and wrongly rejects valid
 *  listings; with it the verdict follows the data (matching category ->
 *  approved/88, mismatching category -> flagged). Currency inside `pricing`
 *  is NOT verified, so it is not sent. `isApproved` is advisory only. */
export interface BusinessModelAuditRequest {
  title: string;
  description: string;
  category: string;
  pricing: { amount: number };
}
export interface BusinessModelAuditResponse {
  /** Newer advisory audits defer approval to a human and return null. */
  isApproved: boolean | null;
  status?: 'REQUIRES_HUMAN_REVIEW';
  scoreBasis?: 'OFFERING_COMPLETENESS_RUBRIC';
  score: number;
  summary: string;
  strengths: string[];
  issues: string[];
  recommendations: string[];
}

/** POST /v1/ai/proposals/enrich — verified request keys: projectId, title,
 *  message, totalPrice, deliveryDays, milestones[{stepOrder,title,description,
 *  days,percentage,amount}]. The service cannot see Waseet's projects, so the
 *  verdict reflects the PROPOSAL's own content (plan, price vs. scope/days);
 *  `aiMatchScore` behaves as a proposal-quality score (92 / 88 / 10 for
 *  strong / strong+cheap / empty proposals), not a match against the real
 *  project, and `aiPriceTag` is not relative to the real project budget. */
export interface EnrichProposalRequest {
  projectId: string;
  title: string;
  message: string;
  totalPrice: number;
  deliveryDays: number;
  milestones?: Array<{ stepOrder: number; title: string; description: string; days: number; percentage: number; amount: number }>;
}
export interface EnrichProposalResponse {
  id: string;
  aiMatchScore: number | null;
  qualityScore?: number;
  scoreBasis?: 'PROPOSAL_QUALITY';
  aiQualityTag: string;
  aiPriceTag: string | null;
  aiFeedback: { summary: string };
}

// AI-13 — POST /v1/ai/matching/projects-for-provider
export interface CandidateProjectInput {
  id: string;
  title: string;
  description?: string;
  requirements?: string[];
  budget?: number;
  duration?: number;
  category?: string;
  isOpen?: boolean;
  status?: string;
}

export interface ProviderProfileInput {
  specialties?: string[];
  skills?: string[];
  experience?: number;
  level?: string;
  hourlyRate?: number;
}

export interface ProviderMatchingRequest {
  providerId?: string;
  provider?: ProviderProfileInput;
  candidates?: CandidateProjectInput[];
  limit?: number;
  specialtyFilter?: string;
  constraints?: {
    budgetMin?: number;
    budgetMax?: number;
    maxDurationDays?: number;
    category?: string;
    requiredSkills?: string[];
    excludedProjectIds?: string[];
  };
}

export interface MatchedProjectItem {
  projectId: string;
  aiMatchScore: number | null;
  matchReasons: string[];
  generationSource: string;
}

export interface ProviderMatchingResponse {
  aiMatchingProjects: MatchedProjectItem[];
  summary: {
    aiRating: number | null;
  };
}

// AI2-06 — GET /v1/ai/assessments/:id/status
export interface AssessmentStatusResponse {
  attemptId: string;
  status: string;
  score: number | null;
  isPassed: boolean | null;
}

/** POST /v1/knowledge/search; audience comes from a server-authenticated actor. */
export interface KnowledgeSearchRequest {
  query: string;
  limit?: number;
  locale?: string;
  audience?: 'all' | 'client' | 'provider' | 'admin';
}
export interface KnowledgeSearchDocument {
  documentId: string;
  version: string;
  title: string;
  locale: string;
  content: string;
  status: 'APPROVED';
  audience: 'all' | 'client' | 'provider' | 'admin';
  createdAt: string;
  approvedBy: string;
  approvedAt: string;
  ownerId?: string;
  sourceUrl?: string;
}
export interface KnowledgeSearchResponse {
  documents: KnowledgeSearchDocument[];
  retrievalMode: 'hybrid' | 'lexical';
}
