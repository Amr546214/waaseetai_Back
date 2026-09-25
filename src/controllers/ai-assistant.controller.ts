import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { geminiClient } from '../services/ai/gemini/gemini.client';

// F3 — Project analysis structured-output contract. Kept local to this
// controller since it's the only consumer; mirrors the exact shape the
// frontend (and this endpoint's own response) has always used.
interface ProjectDeepAnalysis {
	matchPercent: number;
	matchSummary: string;
	winningStrategy: string[];
	suggestedBidPrice: string;
	priceRationale: string;
	clientInsights: string;
	riskAssessment: string;
}

const PROJECT_ANALYSIS_SCHEMA = {
	type: 'object',
	properties: {
		matchPercent: { type: 'number', description: 'نسبة التوافق بين 70 و 99' },
		matchSummary: { type: 'string', description: 'ملخص موجز وقوي يوضح لماذا يمتلك مقدم الخدمة الأفضلية لتنفيذ هذا المشروع' },
		winningStrategy: {
			type: 'array',
			items: { type: 'string' },
			description: '3 نصائح وتوجيهات عملية ملموسة ومبنية على متطلبات المشروع المحددة لإضافتها في العرض'
		},
		suggestedBidPrice: { type: 'string', description: 'السعر المقترح للتسجيل في العرض' },
		priceRationale: { type: 'string', description: 'تبرير السعر استناداً إلى حالة السوق والمنافسة والميزانية' },
		clientInsights: { type: 'string', description: 'تحليل شخصية وتفضيلات العميل بناء على نوع حسابه (شركة أو فرد)' },
		riskAssessment: { type: 'string', description: 'تقييم المخاطر الفنية أو التعاقدية (مثلاً: المدة ضيقة، أو المتطلبات تحتاج تدقيق)' }
	},
	required: ['matchPercent', 'matchSummary', 'winningStrategy', 'suggestedBidPrice', 'priceRationale', 'clientInsights', 'riskAssessment']
};

// Rejects anything that doesn't genuinely match the application contract —
// wrong types, empty strings, an out-of-range score, or an empty strategy
// list all count as an invalid Gemini response, never silently coerced.
function isValidProjectAnalysis(value: unknown): value is ProjectDeepAnalysis {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.matchPercent === 'number' && Number.isFinite(v.matchPercent) && v.matchPercent >= 0 && v.matchPercent <= 100 &&
		typeof v.matchSummary === 'string' && v.matchSummary.trim().length > 0 &&
		Array.isArray(v.winningStrategy) && v.winningStrategy.length > 0 && v.winningStrategy.every((s) => typeof s === 'string' && s.trim().length > 0) &&
		typeof v.suggestedBidPrice === 'string' && v.suggestedBidPrice.trim().length > 0 &&
		typeof v.priceRationale === 'string' && v.priceRationale.trim().length > 0 &&
		typeof v.clientInsights === 'string' && v.clientInsights.trim().length > 0 &&
		typeof v.riskAssessment === 'string' && v.riskAssessment.trim().length > 0
	);
}

export const analyzeProjectForProvider = async (req: Request, res: Response): Promise<void> => {
	try {
		const projectId = req.params.projectId || (req.query.projectId as string) || req.body.projectId;
		if (!projectId) {
			res.status(400).json({ success: false, message: 'Project ID is required' });
			return;
		}

		let userId = (req as any).user?.userId || (req as any).user?.id || null;
		if (!userId) {
			const authHeader = req.headers.authorization;
			if (authHeader && authHeader.startsWith('Bearer ')) {
				try {
					const jwt = require('jsonwebtoken');
						const jwtSecret = process.env.JWT_SECRET;
						if (!jwtSecret) throw new Error('JWT_SECRET is not configured');
						const decoded = jwt.verify(authHeader.split(' ')[1], jwtSecret);
					userId = decoded.userId || decoded.id;
				} catch (e) {}
			}
		}

		const project = await prisma.project.findUnique({
			where: { id: projectId },
			include: {
				client: { select: { accountType: true, firstName: true } },
				proposals: { select: { id: true } },
				projectProposals: { select: { id: true } }
			}
		});

		if (!project) {
			res.status(404).json({ success: false, message: 'Project not found' });
			return;
		}

		let providerSkills: string[] = [];
		let providerRating = 5.0;
		let providerLevel = 1;

		if (userId) {
			const providerProfile = await prisma.providerProfile.findUnique({
				where: { userId },
				include: { skills: true }
			});
			if (providerProfile) {
				providerSkills = providerProfile.skills.map(s => s.name);
				providerRating = providerProfile.rating || 5.0;
			}
			const gamified = await prisma.providerGamification.findUnique({ where: { providerId: userId } });
			if (gamified) {
				providerLevel = gamified.currentLevelIndex;
			}
		}

		const totalProposals = (project as any).proposalsCount || (project.proposals?.length || 0) + (project.projectProposals?.length || 0);
		const isCompany = project.client?.accountType?.includes('COMPANY');
		const clientTypeStr = isCompany ? 'شركة' : 'فرد';
		const budgetStr = project.budgetMin && project.budgetMax ? `${project.budgetMin} - ${project.budgetMax} ريال` : (project.budgetMin ? `${project.budgetMin} ريال` : 'غير محدد');

		const systemPrompt = `
          أنت "وسيط AI"، خبير التحليلات الذكي ومستشار تقديم العروض في منصة وسيط للخدمات الذكية.
          مهمتك هي إجراء فحص عميق وشامل لطلب العميل ومطابقته مع مهارات مقدم الخدمة، وإعطاء استراتيجية عملية وملموسة تضمن لمقدم الخدمة التفوق والفوز بالصفقة.

          بيانات المشروع والعميل:
          - العنوان: "${project.title}"
          - التخصص: ${project.specialty}
          - المتطلبات الفنية: ${(project.requirements || []).join(', ') || 'غير محددة بوضوح'}
          - الميزانية المحددة من العميل: ${budgetStr}
          - المدة الزمنية المستهدفة: ${project.deliveryDays} يوم
          - نوع حساب العميل: ${clientTypeStr}
          - عدد العروض الحالية المقدمة من المنافسين: ${totalProposals}

          بيانات مقدم الخدمة (المستخدم الحالي):
          - المهارات المسجلة: ${providerSkills.join(', ') || 'متخصص عام في المجال'}
          - التقييم المهني: ${providerRating}/5
          - المستوى الاحترافي: المستوى ${providerLevel}

          مطلوب منك توليد التوجيهات باللغة العربية الفصحى المبسطة والواضحة جداً، مع تجنب العموميات وتقديم خطة قابلة للتطبيق الفوري.
        `;

		let analysis: ProjectDeepAnalysis;
		try {
			const result = await geminiClient.generateStructured<ProjectDeepAnalysis>(
				'قم بإعداد التحليل العميق وخطة الفوز الخاصة بي لهذا المشروع.',
				{
					systemInstruction: systemPrompt,
					responseSchema: PROJECT_ANALYSIS_SCHEMA,
					validate: isValidProjectAnalysis,
					temperature: 0.7
				}
			);
			analysis = result.data;
		} catch (geminiError: any) {
			// Honest failure — no hash-derived scores, no invented strengths/
			// weaknesses/recommendations. The AI result is either real and
			// validated, or the client is told it's unavailable.
			console.warn('⚠️ Gemini project analysis unavailable:', geminiError?.code || geminiError?.message);
			res.status(503).json({
				success: false,
				message: 'تعذر إجراء التحليل الذكي لهذا المشروع حالياً، يرجى المحاولة لاحقاً.'
			});
			return;
		}

		// Only reached after a REAL validated Gemini success — cache it, but a
		// caching failure must never turn an otherwise-successful analysis into
		// an error response.
		try {
			await prisma.project.update({
				where: { id: project.id },
				data: { aiAnalysis: analysis } as any
			});
		} catch (cacheErr) {
			console.warn('⚠️ Failed to persist aiAnalysis cache (non-fatal):', cacheErr);
		}

		res.status(200).json({ success: true, data: analysis });
	} catch (error: any) {
		console.error('Analyze Project Fit Error:', error);
		res.status(500).json({ success: false, message: 'Failed to analyze project fit', error: error.message });
	}
};
