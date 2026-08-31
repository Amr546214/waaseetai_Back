/**
 * Prompt Engineering Template for Waseet AI Intelligent Matching Engine
 * Ranks & analyzes top client projects for a provider based on profile, skills, test scores, ratings, and portfolio.
 */

export const AI_MATCHING_ENGINE_SYSTEM_PROMPT = `You are Waseet AI's Chief Matching Algorithm & Talent Matching Engine (محرك المطابقة الذكي في منصة وسيط).
Your responsibility is to analyze a provider's full professional profile (specialties, technical skills, test/quiz results, portfolio work samples, ratings, and experience level) and evaluate candidate open projects to select and rank the TOP 3 most compatible projects.

CRITICAL EVALUATION CRITERIA:
1. SPECIALTY & SKILL ALIGNMENT (40%): How closely project requirements match provider's main specialty, sub-specialties, and verified technical skills.
2. QUIZ & TEST PERFORMANCE (25%): High score in passed tests/quizzes for relevant specialties gives major boost.
3. PORTFOLIO & ACCREDITATION (20%): Relevant past work samples or accreditation projects matching the project requirements.
4. RATING & EXPERIENCE TIER (15%): Provider level (مستكشف, محترف, خبير) and rating average matching project demands.

OUTPUT REQUIREMENTS:
Output strictly valid JSON with no markdown wrapping or extra text. Format:
{
  "matches": [
    {
      "projectId": "string",
      "aiMatchScore": number (integer between 82 and 99),
      "matchReasons": ["string in Arabic (2-3 concise reasons)"],
      "aiAnalysis": "string in Arabic explaining why this project is an ideal match"
    }
  ]
}

STRICT RULE: Select and rank the BEST matching projects (up to 3 projects) from the provided candidate list. Output response in fluent, professional Saudi/Arabic business language.`;

export interface ProviderContextPayload {
  name: string;
  level: string;
  rating: number;
  completedProjects: number;
  headline?: string;
  bio?: string;
  skills: string[];
  specialties: {
    name: string;
    subSpecialties: string[];
    quizScore?: number;
    isPassed: boolean;
    aiScore?: number;
  }[];
  testsPassed: {
    specialtyName: string;
    score: number;
    passed: boolean;
  }[];
  portfolioCount: number;
  accreditationCount: number;
}

export interface CandidateProjectPayload {
  id: string;
  title: string;
  description: string;
  specialty: string;
  subSpecialties: string[];
  requirements: string[];
  budget: number;
  deliveryDays?: number;
  requiredLevel?: string;
}

export function buildAiMatchingUserPrompt(
  provider: ProviderContextPayload,
  candidates: CandidateProjectPayload[]
): string {
  return JSON.stringify({
    providerProfile: provider,
    candidateProjects: candidates
  });
}
