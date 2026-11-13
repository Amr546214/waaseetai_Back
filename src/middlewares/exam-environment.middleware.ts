import { Request, Response, NextFunction } from 'express';
import { examEnvStatus, verifySebRequest, examPublicOrigin } from '../utils/seb-exam';

export const EXAM_ENVIRONMENT_REQUIRED_CODE = 'EXAM_ENVIRONMENT_REQUIRED';
export const EXAM_ENVIRONMENT_NOT_CONFIGURED_CODE = 'EXAM_ENVIRONMENT_NOT_CONFIGURED';

/**
 * Guards every exam route. Mode `off` (default): no restriction, nothing changes. Mode `required`: the request must carry a valid Safe Exam Browser hash for ITS OWN URL
 * (see utils/seb-exam), otherwise nothing is started and no question is sent. Required but not configured => the exam cannot start (fail closed, no silent downgrade).
 */
export function requireExamEnvironment(req: Request, res: Response, next: NextFunction): void {
	const st = examEnvStatus();
	if (st.mode === 'off') return next();
	if (!st.ready) { res.status(503).json({ success: false, code: EXAM_ENVIRONMENT_NOT_CONFIGURED_CODE, message: 'وضع الاختبار المقيّد مطلوب لكنه غير مُهيّأ على الخادم بعد. لا يمكن بدء الاختبار الآن.' }); return; }
	if (!verifySebRequest(req).verified) { res.status(403).json({ success: false, code: EXAM_ENVIRONMENT_REQUIRED_CODE, message: 'هذا الاختبار يُفتح من داخل Safe Exam Browser فقط. افتحه عبر تعليمات الاختبار.' }); return; }
	next();
}

/** For the page: which mode the server runs, whether THIS request came from a verified SEB, and where the instructions point. Never reveals a key. */
export function examEnvironmentStatus(req: Request, res: Response): void {
	const st = examEnvStatus();
	const origin = examPublicOrigin();
	const verified = st.mode === 'required' && st.ready ? verifySebRequest(req).verified : false;
	res.setHeader('Cache-Control', 'no-store');
	res.json({
		success: true,
		data: {
			mode: st.mode, ready: st.ready, verified,
			// the restricted mode can start only when it is both required and ready; `off` means the normal exam (no device restriction)
			restricted: st.mode === 'required',
			...(origin && st.mode === 'required' && st.ready ? { configUrl: `${origin.replace(/^http/, 'seb')}/api/exam-environment/seb-config`, configDownloadUrl: `${origin}/api/exam-environment/seb-config` } : {}),
			downloadUrl: 'https://safeexambrowser.org/download_en.html',
			supportedSystems: [{ system: 'Windows', supported: true }, { system: 'macOS', supported: true }, { system: 'iOS / iPadOS', supported: true, note: 'عبر تطبيق Safe Exam Browser من App Store، بإمكانات أقل من نسخ سطح المكتب' }, { system: 'Android', supported: false }, { system: 'Linux', supported: false }, { system: 'ChromeOS', supported: false }],
			limits: 'لا يمنع هذا الوضع تصوير الشاشة بكاميرا أو جهاز خارجي ولا يضمن حماية مطلقة؛ هو يقيّد المتصفح والتطبيقات والنسخ على الجهاز المدعوم فقط.'
		}
	});
}
