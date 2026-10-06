import { waseetAiClient } from './ai/waseet-ai/waseet-ai.client';
import { normalizeWaseetAiError } from './ai/waseet-ai/waseet-ai.errors';

// BE-2(b): the AI summary stored on a new ClientRequest comes from the verified WaseetAI project-analysis
// call (AI-04 POST /v1/ai/project-analysis). When the call is impossible or fails, both fields are null —
// the old templated summary and the constant aiComplexityRating:'LOW' were not analysis and are gone.
// The vendor response has no complexity field, so aiComplexityRating stays null (never derived from scores).

export const REQUEST_ANALYSIS_CURRENCY = 'USD';
export const REQUEST_ANALYSIS_TIMEOUT_MS = 8000;

export interface RequestAnalysisInput {
	title: string;
	description: string;
	budget: number | null;
	deadlineDays: number;
}

export interface RequestAnalysisFields {
	aiAnalyzedSummary: string | null;
	aiComplexityRating: string | null;
}

const EMPTY: RequestAnalysisFields = { aiAnalyzedSummary: null, aiComplexityRating: null };

export async function analyzeNewRequest(input: RequestAnalysisInput): Promise<RequestAnalysisFields> {
	// the vendor contract requires a numeric budget; without one there is nothing real to analyse
	if (!input.title?.trim() || !input.description?.trim() || !input.budget || input.budget <= 0) return EMPTY;
	try {
		const res = await waseetAiClient.analyzeProject(
			{
				title: input.title,
				description: input.description,
				budget: input.budget,
				deadlineDays: input.deadlineDays,
				currency: REQUEST_ANALYSIS_CURRENCY
			},
			{ timeoutMs: REQUEST_ANALYSIS_TIMEOUT_MS }
		);
		const summary = typeof res?.executiveSummary === 'string' ? res.executiveSummary.trim() : '';
		return { aiAnalyzedSummary: summary || null, aiComplexityRating: null };
	} catch (error) {
		// request creation must never fail because of the analysis; log code/status only, never upstream text
		const e = normalizeWaseetAiError(error);
		console.error(`[ClientRequests] WaseetAI project-analysis failed code=${e.code} status=${e.status ?? '-'} requestId=${e.requestId ?? '-'}`);
		return EMPTY;
	}
}

// Rows created before BE-2(b) carry the old template (`طلب مشروع "…" في تخصص …. الميزانية المقدرة: a - b $.`) and a
// constant 'LOW'. Neither is analysis, so reads treat them as absent instead of presenting them as AI output.
const LEGACY_TEMPLATE = /^طلب مشروع ".*" في تخصص .*\. الميزانية المقدرة: .* \$\.$/s;

export function readAiAnalysis(summary: string | null | undefined, rating: string | null | undefined): { summary: string | null; complexityRating: string | null } | null {
	const legacy = typeof summary === 'string' && LEGACY_TEMPLATE.test(summary.trim());
	const realSummary = !legacy && summary ? summary : null;
	const realRating = legacy ? null : rating || null;
	if (!realSummary && !realRating) return null;
	return { summary: realSummary, complexityRating: realRating };
}
