import { Request, Response, NextFunction } from 'express';
import { examAttemptStateService } from '../services/exam-attempt-state.service';

const sid = (req: Request) => (req.user as { sessionId?: string } | undefined)?.sessionId;

/** The signed-in user's live attempt to resume (questions without answer keys, saved answers, server remaining time), or null. */
export async function getActiveAttempt(req: Request, res: Response, next: NextFunction) {
	try { res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, data: await examAttemptStateService.getActive(req.user!.id, sid(req)) }); } catch (e) { next(e); }
}
/** Silent autosave of the answers so far. */
export async function saveAttemptAnswers(req: Request, res: Response, next: NextFunction) {
	try { res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, data: await examAttemptStateService.saveDraft(req.user!.id, String(req.params.attemptId), req.body?.answers, sid(req), req.body?.seq) }); } catch (e) { next(e); }
}
/** A page / exam-mode event for reviewers (information only). */
export async function logAttemptEvent(req: Request, res: Response, next: NextFunction) {
	try { res.setHeader('Cache-Control', 'no-store'); res.json({ success: true, data: await examAttemptStateService.logEvent(req.user!.id, String(req.params.attemptId), req.body?.type, sid(req)) }); } catch (e) { next(e); }
}
