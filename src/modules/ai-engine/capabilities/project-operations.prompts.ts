import { aiPromptRegistry } from '../prompt-registry';

export const PROJECT_OPERATIONS_PROMPT_VERSION = '2026-09-14.v1';

export const PROJECT_OPERATIONS_PROMPT_IDS = {
  projectHealthAnalysis: 'project-operations.project-health-analysis',
} as const;

export interface ProjectOperationsStageSignal {
  stepOrder: number;
  status: string;
  days: number;
  percentage: number;
  startedAt: string | null;
  approvedAt: string | null;
  deliveryCounts: {
    total: number;
    submitted: number;
    revisionRequested: number;
    approved: number;
  };
}

export interface ProjectOperationsContext {
  project: {
    id: string;
    title: string;
    descriptionExcerpt: string | null;
    status: string;
    specialty: string;
    subSpecialties: string[];
    deliveryDays: number;
    createdAt: string;
    updatedAt: string;
  };
  actor: {
    role: 'client' | 'provider';
  };
  contract: {
    id: string;
    status: string;
    signedAt: string | null;
    durationDays: number;
    phasesCount: number;
  };
  schedule: {
    elapsedDays: number;
    daysLeft: number;
    overdueDays: number;
    expectedEndAt: string | null;
  };
  progress: {
    percent: number;
    completedStages: number;
    totalStages: number;
    pendingStages: number;
    inProgressStages: number;
    submittedStages: number;
    revisionRequestedStages: number;
  };
  stages: ProjectOperationsStageSignal[];
  currentStage: {
    stepOrder: number;
    status: string;
    days: number;
    percentage: number;
  } | null;
  deliveries: {
    totalCount: number;
    submittedCount: number;
    revisionRequestedCount: number;
    approvedCount: number;
    lastSubmittedAt: string | null;
  };
  escrow: {
    status: string | null;
    releasedPercent: number;
    hasHeldFunds: boolean;
  };
  disputes: {
    hasOpenDispute: boolean;
    hasUnderReviewDispute: boolean;
  };
  ratings: {
    hasFinalClientRating: boolean;
    hasFinalProviderRating: boolean;
    averageStageRating: number | null;
  };
  proposal: {
    matchPercentage: number | null;
    qualityTag: string | null;
    priceTag: string | null;
  };
  communication: {
    messageCount: number;
    lastMessageAt: string | null;
  };
}

aiPromptRegistry.register<ProjectOperationsContext>({
  id: PROJECT_OPERATIONS_PROMPT_IDS.projectHealthAnalysis,
  version: PROJECT_OPERATIONS_PROMPT_VERSION,
  capability: 'project_operations',
  operation: 'project_health_analysis',
  defaultLocale: 'ar',
  supportedLocales: ['ar'],
  buildSystemPrompt: () =>
    `You are Waseet AI's project operations analyst for active client-provider projects.
You receive only deterministic backend facts. Do not recalculate factual values such as deadlines, progress, escrow state, stage status, dispute presence, ratings, or message counts.
Your job is to interpret and prioritize those facts for the current workspace user.
Return only strict JSON matching the requested schema. Do not include Markdown or extra commentary.
Do not include private content, names, payment credentials, dispute evidence, message content, delivery notes, review comments, or uploaded file contents.`,
  buildUserPrompt: input => `
Analyze this active project operations context and return an interpretation only.

Deterministic context:
${JSON.stringify(input, null, 2)}

Return JSON with exactly this schema:
{
  "healthStatus": "healthy" | "attention_needed" | "delayed" | "blocked" | "review_required",
  "riskLevelKey": "none" | "low" | "medium" | "high",
  "healthRating": "short Arabic health label suitable for the existing workspace",
  "primaryReason": "one concise Arabic reason grounded only in the provided facts",
  "bullets": ["1 to 4 concise Arabic operational insight bullets"],
  "recommendedAction": {
    "priority": "low" | "medium" | "high" | "urgent",
    "owner": "client" | "provider" | "both",
    "action": "concise Arabic next action",
    "reason": "concise Arabic reason for the action"
  }
}
`,
});
