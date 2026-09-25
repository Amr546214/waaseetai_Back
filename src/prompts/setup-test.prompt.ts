export interface SetupTestQuestion {
  id: string;
  subSpecialtyTag: string;
  text: string;
  options: string[];
  correctOptionIndex: number;
  explanation: string;
}

export interface SetupTestQuizPayload {
  questions: SetupTestQuestion[];
}

export const SETUP_TEST_QUESTION_COUNT = 15;

// AI-16 (provider onboarding "setup test"). Distinct from AI-17's 20-question
// specialty-accreditation quiz (see quiz.prompt.ts's DYNAMIC_QUIZ_SYSTEM_PROMPT)
// — this is a lighter, non-gating calibration quiz shown once during onboarding
// (see setup-test.gateway.ts), always exactly 15 questions, matching this
// feature's own long-standing static fallback question count.
export function buildSetupTestSystemPrompt(): string {
  return `You are an onboarding technical assessor for Waseet AI (وسيط AI), a professional service-mediation platform.

YOUR TASK:
Generate exactly ${SETUP_TEST_QUESTION_COUNT} multiple-choice questions for a service provider's onboarding calibration quiz, covering their declared main specialty and sub-specialties, plus general professional-conduct scenarios relevant to freelance/agency service delivery (client communication, data protection, scope disputes, quality assurance).

RULES:
1. All question text, options, and explanations MUST be in professional modern Arabic (الفصحى المهنية). Technical acronyms may stay in Latin uppercase.
2. Generate EXACTLY ${SETUP_TEST_QUESTION_COUNT} questions — no more, no less.
3. Each question has EXACTLY 4 options ("options" array of 4 distinct strings), with exactly one correct answer identified by its zero-indexed position in "correctOptionIndex" (0-3).
4. Favor realistic professional scenarios over rote definitions.
5. Include a concise Arabic "explanation" for why the correct option is right.
6. Tag each question with "subSpecialtyTag": the specific sub-specialty (or the main specialty if no sub-specialty applies) it relates to.
7. Give each question a unique "id" string (e.g. "q1".."q${SETUP_TEST_QUESTION_COUNT}").

Return ONLY valid JSON matching:
{
  "questions": [
    { "id": "q1", "subSpecialtyTag": "string", "text": "string", "options": ["string","string","string","string"], "correctOptionIndex": 0, "explanation": "string" }
    // ... exactly ${SETUP_TEST_QUESTION_COUNT} items total
  ]
}`;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function isValidSetupTestQuestion(value: unknown): value is SetupTestQuestion {
  if (!value || typeof value !== 'object') return false;
  const q = value as Record<string, unknown>;
  if (!isNonEmptyString(q.id)) return false;
  if (!isNonEmptyString(q.subSpecialtyTag)) return false;
  if (!isNonEmptyString(q.text)) return false;
  if (!Array.isArray(q.options) || q.options.length !== 4 || !q.options.every(isNonEmptyString)) return false;
  if (typeof q.correctOptionIndex !== 'number' || !Number.isInteger(q.correctOptionIndex) || q.correctOptionIndex < 0 || q.correctOptionIndex > 3) return false;
  if (!isNonEmptyString(q.explanation)) return false;
  return true;
}

// Rejects anything that doesn't genuinely satisfy the setup-test contract —
// wrong question count, a malformed question, an out-of-range correct
// answer, or duplicate ids are all invalid, never silently patched or
// truncated/padded to fit.
export function isValidSetupTestQuizPayload(value: unknown): value is SetupTestQuizPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.questions) || v.questions.length !== SETUP_TEST_QUESTION_COUNT) return false;
  if (!v.questions.every(isValidSetupTestQuestion)) return false;
  const ids = new Set((v.questions as SetupTestQuestion[]).map((q) => q.id));
  if (ids.size !== v.questions.length) return false;
  return true;
}

export const SETUP_TEST_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: `قائمة من ${SETUP_TEST_QUESTION_COUNT} سؤال اختيار من متعدد`,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          subSpecialtyTag: { type: 'string' },
          text: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correctOptionIndex: { type: 'number' },
          explanation: { type: 'string' }
        },
        required: ['id', 'subSpecialtyTag', 'text', 'options', 'correctOptionIndex', 'explanation']
      }
    }
  },
  required: ['questions']
};
