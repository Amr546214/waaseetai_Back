import { AssessmentStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { SUBMITTABLE_STATUSES, sanitizeQuestions, ASSESSMENT_TIME_LIMIT_MINUTES } from './ai-assessment.service';

/**
 * Server-side state of a live specialty test attempt, kept in the attempt's existing JSON snapshot (no new column):
 *  - draftAnswers   : the answers as the user goes (silent autosave); survives a closed tab, a lost connection or a reload; final grading still uses the submitted answers (drafts only fill gaps)
 *  - integrityEvents: page hidden / left the exam / went offline, as EVENTS with server time. They are information for a reviewer: never a score, never an automatic failure, and a window blur alone proves nothing
 *  - boundSessionId : the login session that opened the attempt; another session cannot read, change or submit it (default ON, EXAM_BIND_SESSION=false turns it off)
 * The clock is the server's (startedAt + time limit); the browser only displays it.
 */
export const MAX_DRAFT_ANSWERS = 100;
export const MAX_INTEGRITY_EVENTS = 200;
export const INTEGRITY_EVENT_TYPES = ['PAGE_HIDDEN', 'PAGE_VISIBLE', 'WINDOW_BLUR', 'WINDOW_FOCUS', 'LEFT_EXAM_MODE', 'OFFLINE', 'ONLINE', 'PAGE_RELOADED', 'SEB_NOT_VERIFIED'] as const;
export type IntegrityEventType = (typeof INTEGRITY_EVENT_TYPES)[number];

type Snapshot = Record<string, unknown>;
const asSnapshot = (v: unknown): Snapshot => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Snapshot) } : {});
const bindSessions = (env: NodeJS.ProcessEnv = process.env) => String(env.EXAM_BIND_SESSION ?? 'true').trim().toLowerCase() !== 'false';
export const remainingSeconds = (startedAt: Date, limitMinutes: number, now = new Date()) => Math.max(0, Math.floor((new Date(startedAt).getTime() + limitMinutes * 60_000 - now.getTime()) / 1000));

type Tx = Prisma.TransactionClient;
export const lockAttempt = (tx: Tx, attemptId: string) => tx.$queryRaw`SELECT id FROM assessment_attempts WHERE id = ${attemptId} FOR UPDATE`;
async function ownedActive(userId: string, attemptId: string, db: Tx | typeof prisma = prisma) {
	const attempt = await db.assessmentAttempt.findFirst({
		where: { id: attemptId, status: { in: SUBMITTABLE_STATUSES }, providerSpecialty: { providerProfile: { userId } } },
		select: { id: true, providerSpecialtyId: true, questionsPayload: true, analyzedAssetsSnapshot: true, startedAt: true, timeLimitMinutes: true, status: true }
	});
	if (!attempt) throw new AppError('محاولة التقييم غير موجودة أو انتهت.', 404, undefined, 'ATTEMPT_NOT_ACTIVE');
	return attempt;
}

/** The first REST touch binds the attempt to the login session; a different session afterwards is refused. */
function checkSession(snapshot: Snapshot, sessionId: string | undefined): { snapshot: Snapshot; changed: boolean } {
	if (!bindSessions() || !sessionId) return { snapshot, changed: false };
	const bound = typeof snapshot.boundSessionId === 'string' ? snapshot.boundSessionId : null;
	if (!bound) return { snapshot: { ...snapshot, boundSessionId: sessionId }, changed: true };
	if (bound !== sessionId) throw new AppError('بدأ هذا الاختبار من جلسة دخول أخرى ولا يمكن متابعته من هذه الجلسة.', 409, undefined, 'ATTEMPT_SESSION_MISMATCH');
	return { snapshot, changed: false };
}

const cleanAnswers = (raw: unknown, allowedIds: Set<string>): Record<string, string> => {
	const out: Record<string, string> = {};
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			if (Object.keys(out).length >= MAX_DRAFT_ANSWERS) break;
			if (allowedIds.has(k) && typeof v === 'string' && v.length > 0 && v.length <= 50) out[k] = v;
		}
	}
	return out;
};

export class ExamAttemptStateService {
	/** The user's live attempt (if any) for the page to resume: key-less questions, saved answers and the server's remaining time. */
	async getActive(userId: string, sessionId?: string) {
		const attempt = await prisma.assessmentAttempt.findFirst({
			where: { status: { in: SUBMITTABLE_STATUSES }, providerSpecialty: { providerProfile: { userId } } },
			orderBy: { createdAt: 'desc' },
			select: { id: true, providerSpecialtyId: true, questionsPayload: true, analyzedAssetsSnapshot: true, startedAt: true, timeLimitMinutes: true, status: true }
		});
		if (!attempt) return null;
		const questions = (Array.isArray(attempt.questionsPayload) ? attempt.questionsPayload : []) as any[];
		const left = remainingSeconds(attempt.startedAt, attempt.timeLimitMinutes || ASSESSMENT_TIME_LIMIT_MINUTES);
		if (attempt.status === AssessmentStatus.STREAMING && questions.length === 0) return null; // still being generated: nothing to resume yet
		const { snapshot, changed } = checkSession(asSnapshot(attempt.analyzedAssetsSnapshot), sessionId);
		if (changed) await prisma.assessmentAttempt.update({ where: { id: attempt.id }, data: { analyzedAssetsSnapshot: snapshot as Prisma.InputJsonValue } });
		const draft = cleanAnswers(snapshot.draftAnswers, new Set(questions.map(q => String(q.id))));
		return {
			attemptId: attempt.id, providerSpecialtyId: attempt.providerSpecialtyId, status: attempt.status,
			questions: sanitizeQuestions(questions).map(q => ({ id: q.id, textAr: q.textAr, options: q.options, ...(q.assessmentArea ? { difficulty: q.assessmentArea } : {}) })),
			totalQuestions: questions.length || undefined, timeLimitMinutes: attempt.timeLimitMinutes, remainingSeconds: left, expired: left <= 0, answers: draft
		};
	}

	/** Silent autosave: merges (never replaces with fewer) the draft; only ids of this attempt's questions, short option ids. */
	async saveDraft(userId: string, attemptId: string, rawAnswers: unknown, sessionId?: string) {
		return prisma.$transaction(async (tx) => {
			await lockAttempt(tx, attemptId); // the snapshot is read-modify-written by several writers (answer timing, drafts, events): one at a time
			const attempt = await ownedActive(userId, attemptId, tx);
			const left = remainingSeconds(attempt.startedAt, attempt.timeLimitMinutes || ASSESSMENT_TIME_LIMIT_MINUTES);
			if (left <= 0) return { saved: false, remainingSeconds: 0, expired: true };
			const questions = (Array.isArray(attempt.questionsPayload) ? attempt.questionsPayload : []) as any[];
			const ids = new Set(questions.map(q => String(q.id)));
			const incoming = cleanAnswers(rawAnswers, ids);
			const { snapshot } = checkSession(asSnapshot(attempt.analyzedAssetsSnapshot), sessionId);
			const merged = { ...cleanAnswers(snapshot.draftAnswers, ids), ...incoming };
			await tx.assessmentAttempt.update({ where: { id: attempt.id }, data: { analyzedAssetsSnapshot: { ...snapshot, draftAnswers: merged, draftSavedAt: new Date().toISOString() } as Prisma.InputJsonValue } });
			return { saved: true, remainingSeconds: left, expired: false, count: Object.keys(merged).length };
		});
	}

	/** Records an event for reviewers. Never changes the score or the status. */
	async logEvent(userId: string, attemptId: string, type: unknown, sessionId?: string) {
		if (!INTEGRITY_EVENT_TYPES.includes(type as IntegrityEventType)) throw new AppError('نوع الحدث غير معروف.', 400, undefined, 'INVALID_EVENT');
		return prisma.$transaction(async (tx) => {
			await lockAttempt(tx, attemptId);
			const attempt = await ownedActive(userId, attemptId, tx);
			const { snapshot } = checkSession(asSnapshot(attempt.analyzedAssetsSnapshot), sessionId);
			const events = (Array.isArray(snapshot.integrityEvents) ? snapshot.integrityEvents : []) as { type: string; t: number }[];
			if (events.length >= MAX_INTEGRITY_EVENTS) return { recorded: false };
			const last = events[events.length - 1];
			const now = Date.now();
			if (last && last.type === type && now - last.t < 1000) return { recorded: false }; // the same event twice within a second is one event
			await tx.assessmentAttempt.update({ where: { id: attempt.id }, data: { analyzedAssetsSnapshot: { ...snapshot, integrityEvents: [...events, { type, t: now }] } as Prisma.InputJsonValue } });
			return { recorded: true };
		});
	}
}

export const examAttemptStateService = new ExamAttemptStateService();
