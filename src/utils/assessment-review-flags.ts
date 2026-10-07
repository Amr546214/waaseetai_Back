// AUD-FND-000020 — review flags for an assessment attempt. A flag NEVER fails the attempt, changes its score or status, or blocks anything:
// it only marks the attempt "for review" so an admin can look at it. Thresholds are configurable through environment variables.
export interface AssessmentFlagConfig {
	minSecondsPerQuestion: number;
	minTotalSeconds: number;
	patternRatio: number;
	fastAnswerMinCount: number;
}

const num = (raw: string | undefined, fallback: number, min: number, max: number) => {
	const n = Number(raw);
	return raw !== undefined && raw !== '' && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

export function assessmentFlagConfig(env: NodeJS.ProcessEnv = process.env): AssessmentFlagConfig {
	return {
		minSecondsPerQuestion: num(env.ASSESSMENT_MIN_SECONDS_PER_QUESTION, 3, 0, 120),
		minTotalSeconds: num(env.ASSESSMENT_MIN_TOTAL_SECONDS, 80, 0, 3600),
		patternRatio: num(env.ASSESSMENT_PATTERN_RATIO, 0.9, 0.5, 1),
		// how many answers faster than the per-question minimum are needed before the attempt is marked (a single quick click is normal)
		fastAnswerMinCount: Math.round(num(env.ASSESSMENT_FAST_ANSWER_MIN_COUNT, 3, 1, 50)),
	};
}

export type AssessmentFlagCode = 'TOTAL_TIME_TOO_SHORT' | 'FAST_ANSWERS' | 'UNIFORM_ANSWERS' | 'REPEATING_PATTERN';

export const ASSESSMENT_FLAG_LABELS_AR: Record<AssessmentFlagCode, string> = {
	TOTAL_TIME_TOO_SHORT: 'زمن الاختبار الكلي أقل من الحد الأدنى',
	FAST_ANSWERS: 'إجابات متتالية أسرع من الحد الأدنى لكل سؤال',
	UNIFORM_ANSWERS: 'نسبة كبيرة من الإجابات بنفس الخيار',
	REPEATING_PATTERN: 'تكرار دوري ثابت في الإجابات',
};

export interface AnswerLogEntry { q: string; a: string; t: number }
export interface AssessmentReviewInput {
	/** Question ids in the order they were shown. */
	questionIds: string[];
	answers: Record<string, string>;
	startedAt: Date;
	completedAt: Date;
	/** First answer given for each question, with the server receive time (ms). Empty when the client never reported answers one by one. */
	answerLog?: AnswerLogEntry[];
}
export interface AssessmentReview {
	flagged: boolean;
	flags: { code: AssessmentFlagCode; label: string }[];
	measured: { totalSeconds: number; answered: number; fastAnswers: number | null; topShare: number | null; periodicCycle: number | null };
	thresholds: AssessmentFlagConfig;
	evaluatedAt: string;
}

/** The shortest cycle length (2..4) that explains the WHOLE answer sequence (and is not a single repeated value), or null. */
export function periodicCycle(sequence: string[]): number | null {
	if (sequence.length < 8 || new Set(sequence).size < 2) return null;
	for (let p = 2; p <= 4; p++) {
		if (sequence.every((v, i) => i < p || v === sequence[i - p])) return p;
	}
	return null;
}

export function evaluateAssessment(input: AssessmentReviewInput, config: AssessmentFlagConfig = assessmentFlagConfig()): AssessmentReview {
	const flags: AssessmentReview['flags'] = [];
	const add = (code: AssessmentFlagCode) => flags.push({ code, label: ASSESSMENT_FLAG_LABELS_AR[code] });

	const totalSeconds = Math.max(0, Math.round((input.completedAt.getTime() - input.startedAt.getTime()) / 1000));
	if (totalSeconds < config.minTotalSeconds) add('TOTAL_TIME_TOO_SHORT');

	const ordered = input.questionIds.map(id => String(input.answers[id] ?? '').trim().toLowerCase()).filter(Boolean);
	const answered = ordered.length;

	let topShare: number | null = null;
	if (answered >= 5) {
		const counts = new Map<string, number>();
		for (const v of ordered) counts.set(v, (counts.get(v) ?? 0) + 1);
		topShare = Math.max(...counts.values()) / answered;
		if (topShare >= config.patternRatio) add('UNIFORM_ANSWERS');
	}

	const cycle = periodicCycle(ordered);
	if (cycle !== null && !(topShare !== null && topShare >= config.patternRatio)) add('REPEATING_PATTERN');

	let fastAnswers: number | null = null;
	const log = (input.answerLog ?? []).slice().sort((a, b) => a.t - b.t);
	if (log.length > 0) {
		let previous = input.startedAt.getTime();
		fastAnswers = 0;
		for (const entry of log) {
			if ((entry.t - previous) / 1000 < config.minSecondsPerQuestion) fastAnswers++;
			previous = entry.t;
		}
		if (fastAnswers >= config.fastAnswerMinCount) add('FAST_ANSWERS');
	}

	return { flagged: flags.length > 0, flags, measured: { totalSeconds, answered, fastAnswers, topShare: topShare === null ? null : Math.round(topShare * 100) / 100, periodicCycle: cycle }, thresholds: config, evaluatedAt: new Date().toISOString() };
}
