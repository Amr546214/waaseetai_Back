import { Request, Response, NextFunction } from 'express';
import { examEnvStatus, verifySebRequest, examPublicOrigin } from '../utils/seb-exam';
import { sebJsApiEnabled, verifySebAccessProof } from '../utils/seb-js-proof';

const verifiedExamRequest = (req: Request) => verifySebRequest(req).verified || verifySebAccessProof(req.headers['x-waseet-seb-proof'], req.user);

export const EXAM_ENVIRONMENT_REQUIRED_CODE = 'EXAM_ENVIRONMENT_REQUIRED';
export const EXAM_ENVIRONMENT_NOT_CONFIGURED_CODE = 'EXAM_ENVIRONMENT_NOT_CONFIGURED';

/**
 * Guards every exam route. Mode `off` (default): unchanged. In `required`, either
 * a classic per-request hash or an authenticated, session-bound modern proof
 * is required. Required but not configured fails closed before any questions.
 */
export function requireExamEnvironment(req: Request, res: Response, next: NextFunction): void {
	const st = examEnvStatus();
	if (st.mode === 'off') return next();
	if (!st.ready) { res.status(503).json({ success: false, code: EXAM_ENVIRONMENT_NOT_CONFIGURED_CODE, message: 'وضع الاختبار المقيّد مطلوب لكنه غير مُهيّأ على الخادم بعد. لا يمكن بدء الاختبار الآن.' }); return; }
	if (!verifiedExamRequest(req)) { res.status(403).json({ success: false, code: EXAM_ENVIRONMENT_REQUIRED_CODE, message: 'هذا الاختبار يُفتح من داخل Safe Exam Browser فقط. افتحه عبر تعليمات الاختبار.' }); return; }
	next();
}

/** For the page: which mode the server runs, whether THIS request came from a verified SEB, and where the instructions point. Never reveals a key. */
export function examEnvironmentStatus(req: Request, res: Response): void {
	const st = examEnvStatus();
	const origin = examPublicOrigin();
	const verified = st.mode === 'required' && st.ready ? verifiedExamRequest(req) : false;
	res.setHeader('Cache-Control', 'no-store');
	res.json({
		success: true,
		data: {
			mode: st.mode, ready: st.ready, verified, jsApiEnabled: sebJsApiEnabled(),
			// the restricted mode can start only when it is both required and ready; `off` means the normal exam (no device restriction)
			restricted: st.mode === 'required',
			// keys / file being present is NOT the same as the integration having been tried in a real SEB: the page says which
			testedInRealSeb: st.testedInRealSeb, testedNote: st.testedNote,
			...(origin && st.mode === 'required' && st.ready ? { configUrl: `${origin.replace(/^http/, 'seb')}/api/exam-environment/seb-config`, configDownloadUrl: `${origin}/api/exam-environment/seb-config` } : {}),
			downloadUrl: 'https://safeexambrowser.org/download_en.html',
			supportedSystems: [
				{ system: 'Windows', supported: true, note: 'يُرسل SEB مفاتيحه في ترويسات الطلبات (المحرك الكلاسيكي)' },
				{ system: 'macOS', supported: true, note: 'المحرك الحديث يحتاج تفعيل تحقق SEB JavaScript API على الخادم وتجربة ربطه فعليًا؛ نجاح قفل الجهاز وحده لا يثبت الربط' },
				{ system: 'iOS / iPadOS', supported: true, note: 'المحرك الحديث يحتاج تحقق SEB JavaScript API؛ يلزم اختبار فعلي لهذا النظام وإعداد وضع التقييم وكلمة مرور الخروج' },
				{ system: 'Android', supported: false }, { system: 'Linux', supported: false }, { system: 'ChromeOS', supported: false }
			],
			limits: 'لا يمنع هذا الوضع تصوير الشاشة بكاميرا أو جهاز خارجي ولا يضمن حماية مطلقة؛ هو يقيّد المتصفح والتطبيقات والنسخ على الجهاز المدعوم فقط، بحسب قدرات SEB لكل نظام. والخروج من SEB أثناء المحاولة ممكن (Ctrl/Cmd-Q أو زر الإغلاق) فيستمر الوقت وتبقى المحاولة محفوظة.'
		}
	});
}
