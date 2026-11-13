import { Router } from 'express';
import { examEnvStatus, buildSebConfig, examPublicOrigin } from '../utils/seb-exam';

const router = Router();
// GET /api/exam-environment/seb-config — the SEB settings file (opened by SEB through sebs://). Public on purpose (SEB downloads it before any login) and contains no secret.
router.get('/seb-config', (_req, res) => {
	const st = examEnvStatus(); const origin = examPublicOrigin();
	if (st.mode !== 'required' || !st.ready || !origin) { res.status(404).json({ success: false, message: 'وضع الاختبار المقيّد غير مفعّل.' }); return; }
	res.setHeader('Content-Type', 'application/seb; charset=utf-8');
	res.setHeader('Content-Disposition', 'attachment; filename="waseet-exam.seb"');
	res.setHeader('Cache-Control', 'no-store');
	res.send(buildSebConfig(origin));
});
export default router;
