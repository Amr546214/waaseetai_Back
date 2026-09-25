export interface DynamicQuizQuestion {
  id: string;
  subSpecialtyTag: string;
  text: string;
  options: string[];
  correctOptionIndex: number;
  explanation: string;
}

export interface DynamicQuizPayload {
  specialtyName: string;
  totalQuestions: number;
  durationMins: number;
  passThresholdPercent: number;
  questions: DynamicQuizQuestion[];
}

export const DYNAMIC_QUIZ_QUESTION_COUNT = 20;

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function isValidDynamicQuizQuestion(value: unknown): value is DynamicQuizQuestion {
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

// Rejects anything that doesn't genuinely satisfy the AI-17 specialty-quiz
// contract — wrong question count, a malformed question, an out-of-range
// correct answer, or duplicate ids are all invalid. Never trusted directly:
// the DB payload this validates against is only ever overwritten by the
// caller after this returns true (see quiz.controller.ts's background
// Gemini refinement).
export function isValidDynamicQuizQuestions(value: unknown): value is DynamicQuizQuestion[] {
  if (!Array.isArray(value) || value.length !== DYNAMIC_QUIZ_QUESTION_COUNT) return false;
  if (!value.every(isValidDynamicQuizQuestion)) return false;
  const ids = new Set((value as DynamicQuizQuestion[]).map((q) => q.id));
  return ids.size === value.length;
}

export interface DynamicQuizGenerationResult {
  questions: DynamicQuizQuestion[];
}

export const DYNAMIC_QUIZ_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: `قائمة من ${DYNAMIC_QUIZ_QUESTION_COUNT} سؤال اختيار من متعدد`,
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

function isValidDynamicQuizGenerationResult(value: unknown): value is DynamicQuizGenerationResult {
  if (!value || typeof value !== 'object') return false;
  return isValidDynamicQuizQuestions((value as Record<string, unknown>).questions);
}

export { isValidDynamicQuizGenerationResult };

export const DYNAMIC_QUIZ_SYSTEM_PROMPT = `You are the Lead Chief Examiner and Technical Skill Assessor at Waseet AI (وسيط AI), the premier AI-powered service mediation and professional networking platform in the Middle East.

YOUR CORE RESPONSIBILITY:
You must generate a rigorous, standardized, 20-question multiple-choice technical verification quiz for a service provider seeking accreditation in their selected primary specialty and sub-specialties. This examination is designed to filter out unqualified operators and certify high-performing specialists.

MANDATORY EXAMINATION GENERATION RULES:
1. STRICT ARABIC LANGUAGE REQUIREMENT: All questions, options, and explanations MUST be written in highly articulated, flawless modern professional Arabic (الفصحى المهنية). Technical acronyms (e.g., API, CI/CD, SEO, UI/UX, DNS, SQL) may be kept in uppercase Latin characters within the Arabic sentence structure where appropriate.
2. EXACTLY 20 QUESTIONS: You must generate precisely 20 multiple-choice questions. No more, no less.
3. MANDATORY 5+5+5+5 DISTRIBUTION: Questions 1-5 cover the primary specialty (tag: "التخصص الرئيسي"). Questions 6-10 cover the selected sub-specialties (tag: "التخصص الفرعي"). Questions 11-15 test the submitted work samples, implementation decisions, and declared technologies (tag: "نموذج العمل والتقنيات"). Questions 16-20 test client discovery, persuasion, objection handling, ethical negotiation, value presentation, and closing project deals (tag: "مهارات العميل والصفقات"). This exact distribution must never change.
4. FOUR OPTIONS & DETERMINISTIC CORRECT ANSWER: Each question must feature exactly four distinct options ("options" array of 4 strings). Exactly one option is correct. Indicate the zero-indexed integer of the correct answer in "correctOptionIndex" (0, 1, 2, or 3).
5. COGNITIVE DEPTH & REAL-WORLD SCENARIOS: Avoid trivial rote memorization or textbook definitions. Questions should present practical real-world engineering dilemmas, production failure debugging, client architecture trade-offs, security vulnerability mitigation, design system scalability, or regulatory compliance scenarios.
6. PROFESSIONAL EXPLANATIONS: Include a concise, illuminating explanation ("explanation") in Arabic detailing why the selected option represents the industry best practice and why alternative options are sub-optimal or flawed.

STRICT JSON CONTRACT ENFORCEMENT:
Output exclusively valid JSON matching this structure exactly without any introductory text, markdown formatting blocks outside JSON, or postscript chatter:
{
  "specialtyName": "string representing primary domain",
  "totalQuestions": 20,
  "durationMins": 30,
  "passThresholdPercent": 25.0,
  "questions": [
    {
      "id": "q1",
      "subSpecialtyTag": "One of the four mandatory Arabic section tags",
      "text": "The problem statement / question in professional Arabic",
      "options": [
        "Option A (index 0)",
        "Option B (index 1)",
        "Option C (index 2)",
        "Option D (index 3)"
      ],
      "correctOptionIndex": 1,
      "explanation": "Concise justification for why option B is correct in professional Arabic"
    }
    // ... exactly 20 question items total (q1 to q20)
  ]
}`;
