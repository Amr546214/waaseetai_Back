import { Router } from 'express';
import { examEnvStatus, approvedSebConfig } from '../utils/seb-exam';
import { authenticate, requireActiveUser } from '../middlewares/auth.middleware';
import { requireExamEnvironment } from '../middlewares/exam-environment.middleware';
import { issueExamTicket } from '../utils/exam-ticket';

const router = Router();
// GET /api/exam-environment/seb-config — serves EXACTLY the approved settings file (the one the server's keys were taken from; digest-checked). Public on purpose (SEB downloads it before any
// login) and it contains no secret. It is never generated here.
router.get('/seb-config', (_req, res) => {
	const st = examEnvStatus(); const f = approvedSebConfig();
	if (st.mode !== 'required' || !st.ready || !f.ok) { res.status(404).json({ success: false, message: 'وضع الاختبار المقيّد غير مفعّل أو ملف الإعدادات المعتمد غير جاهز.' }); return; }
	res.setHeader('Content-Type', 'application/seb');
	res.setHeader('Content-Disposition', 'attachment; filename="waseet-exam.seb"');
	res.setHeader('X-Config-SHA256', f.sha256);
	res.setHeader('Cache-Control', 'no-store');
	res.send(f.bytes);
});

// POST /api/exam-environment/ticket — passes only from a verified Safe Exam Browser in restricted mode (the middleware checks the hash of THIS request); in the default mode nothing is restricted and it just issues.
router.post('/ticket', authenticate, requireActiveUser, requireExamEnvironment, (req, res) => {
	const sessionId = (req.user as { sessionId?: string } | undefined)?.sessionId;
	if (!sessionId) { res.status(403).json({ success: false, code: 'ATTEMPT_SESSION_UNKNOWN', message: 'تعذر تحديد جلسة الدخول، سجّل الدخول من جديد.' }); return; }
	res.setHeader('Cache-Control', 'no-store');
	res.json({ success: true, data: issueExamTicket(req.user!.id, sessionId, 'SETUP_TEST') });
});
export default router;
