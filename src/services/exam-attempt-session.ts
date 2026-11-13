import { AppError } from '../utils/app-error';

/**
 * Session binding of a live specialty-test attempt: the attempt belongs to the login session that CREATED it (bound inside the creating transaction), and every later read,
 * save, event, answer timing, submit and socket event must come from that same session. A second session of the same user can neither read nor change nor submit it.
 *
 * Default ON (EXAM_BIND_SESSION=false turns it off, then nothing here refuses). A caller whose session cannot be determined is refused EXPLICITLY (ATTEMPT_SESSION_UNKNOWN), never let through.
 * Attempts created before this feature have no binding (`boundSessionId` absent): they are bound by the first locked touch (read/save/event) and a submit is allowed for them; no attempt created
 * after it can be unbound.
 */
export const ATTEMPT_SESSION_MISMATCH_CODE = 'ATTEMPT_SESSION_MISMATCH';
export const ATTEMPT_SESSION_UNKNOWN_CODE = 'ATTEMPT_SESSION_UNKNOWN';
export const ATTEMPT_SESSION_MISMATCH_MESSAGE = 'بدأ هذا الاختبار من جلسة دخول أخرى ولا يمكن متابعته أو تسليمه من هذه الجلسة.';
export const ATTEMPT_SESSION_UNKNOWN_MESSAGE = 'تعذر تحديد جلسة الدخول لهذا الطلب، سجّل الدخول من جديد ثم أعد المحاولة.';

export type Snapshot = Record<string, unknown>;
export const asSnapshot = (v: unknown): Snapshot => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Snapshot) } : {});
export const bindingEnabled = (env: NodeJS.ProcessEnv = process.env) => String(env.EXAM_BIND_SESSION ?? 'true').trim().toLowerCase() !== 'false';
export const boundSessionOf = (snapshot: unknown): string | null => { const v = asSnapshot(snapshot).boundSessionId; return typeof v === 'string' && v ? v : null; };

export type SessionVerdict = 'OK' | 'UNBOUND_LEGACY' | 'SESSION_UNKNOWN' | 'MISMATCH';
/** Pure decision (no throw): used by services that answer with an outcome kind (submission) and by the throwing variant below. */
export function sessionVerdict(snapshot: unknown, sessionId: string | undefined | null, env: NodeJS.ProcessEnv = process.env): SessionVerdict {
	if (!bindingEnabled(env)) return 'OK';
	if (!sessionId) return 'SESSION_UNKNOWN';
	const bound = boundSessionOf(snapshot);
	if (!bound) return 'UNBOUND_LEGACY';
	return bound === sessionId ? 'OK' : 'MISMATCH';
}

export const sessionError = (v: 'SESSION_UNKNOWN' | 'MISMATCH') => v === 'MISMATCH'
	? new AppError(ATTEMPT_SESSION_MISMATCH_MESSAGE, 409, undefined, ATTEMPT_SESSION_MISMATCH_CODE)
	: new AppError(ATTEMPT_SESSION_UNKNOWN_MESSAGE, 403, undefined, ATTEMPT_SESSION_UNKNOWN_CODE);

/** Throws on refusal. Returns the snapshot to WRITE (bound to this session when it was a legacy unbound attempt) and whether it changed. Call inside the attempt's row lock. */
export function enforceSession(snapshot: unknown, sessionId: string | undefined | null): { snapshot: Snapshot; changed: boolean } {
	const v = sessionVerdict(snapshot, sessionId);
	if (v === 'SESSION_UNKNOWN' || v === 'MISMATCH') throw sessionError(v);
	const base = asSnapshot(snapshot);
	if (v === 'UNBOUND_LEGACY' && sessionId) return { snapshot: { ...base, boundSessionId: sessionId }, changed: true };
	return { snapshot: base, changed: false };
}
