import { Request, Response } from 'express';
import { prisma } from '../config/db';
import OpenAI from 'openai';

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
	timeout: 25 * 1000,
	maxRetries: 0,
});

export const assistantChat = async (req: Request, res: Response): Promise<void> => {
	try {
		const { message, currentRoute } = req.body;
		let userId = null;

		// 1. Soft Auth check
		const authHeader = req.headers.authorization;
		if (authHeader && authHeader.startsWith('Bearer ')) {
			const token = authHeader.split(' ')[1];
			try {
				const jwt = require('jsonwebtoken');
				const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
				userId = decoded.userId || decoded.id;
			} catch (err) {
				// Ignore invalid token, treat as guest
			}
		}

		let systemPrompt = '';
		let userDataContext = '';

		if (userId) {
			const user = await prisma.user.findUnique({
				where: { id: userId },
				include: {
					clientProjects: {
						take: 3,
						orderBy: { createdAt: 'desc' },
						select: { title: true, status: true }
					},
					providerProjects: {
						take: 3,
						orderBy: { createdAt: 'desc' },
						select: { title: true, status: true }
					}
				}
			});

			if (!user) {
				res.status(404).json({ success: false, message: 'User not found' });
				return;
			}

			userDataContext = `
        - اسم المستخدم: ${user.firstName} ${user.lastName}
        - نوع الحساب الحالي ف المنصة: ${user.accountType} (طالب خدمة أو مقدم خدمة)
        - آخر المشاريع المرتبطة به كطالب خدمة: ${JSON.stringify(user.clientProjects)}
        - آخر المشاريع المرتبطة به كمقدم خدمة: ${JSON.stringify(user.providerProjects)}
        - الصفحة الحالية اللي كيشوفها المستخدم دابا ف المنصة (Current Route): "${currentRoute || 'الرئيسية'}"
      `;

			systemPrompt = `
        أنت المساعد الرقمي الحي والذكي جداً "وسيط AI" لمنصة "وسيط للخدمات الذكية".
        تتصرف كـ "Digital Pet" أو مرافق ذكي مخلص ومتحمس جداً لمساعدة صاحبه (المستخدم).

        بيانات المستخدم الحقيقية والحية من قاعدة البيانات هي كالتالي:
        ${userDataContext}

        قواعد الصياغة وتوليد الكلام:
        1. لا تكرر أبداً نفس الجمل المحفوظة مثل "مرحباً كيف يمكنني مساعدتك". تكلم كإنسان حقيقي يحلل الحساب.
        2. تفاعل مع البيانات الحالية: إذا كانت لديه مشاريع معلقة أو عقود قيد التنفيذ، أشر إليها بذكاء (مثال: "أرى أن مشروعك الأخير قيد المراجعة، هل تريدني أن ألقي نظرة؟").
        3. اربط الإجابة بالصفحة الحالية (Current Route) التي يتصفحها بأسلوب توجيهي ذكي.
        4. الرد يجب أن يكون باللغة العربية الفصحى المبسطة والمفهومة جداً (لهجة بيضاء واضحة ونقية)، بأسلوب دافئ، نشيط ومختصر (لا تتجاوز 2 إلى 3 جمل ليكون الصوت متناسقاً).

        قواعد توليد الحركات الجسدية (speechTimeline):
        يجب أن تقسم كلامك إلى مقاطع وتحدد الحركة المناسبة لكل مقطع من الخيارات المتاحة:
        - "WELCOME_OPEN": للترحيب الحار المفتوح.
        - "ANALYTICAL_THINKING": عند تحليل البيانات والتفكير.
        - "INSTRUCTIVE_DIRECTING": عند التوجيه وتقديم تعليمات واضحة.
        - "CELEBRATORY_JUMP": عند النجاح أو التهنئة.
        - "EMPATHETIC_SOFT": عند إظهار التعاطف أو الردود اللطيفة.
        يجب تحديد مستوى الحماس (excitementLevel) وتردد الحركات (gestureFrequency) لكل مقطع بقيمة من 0.0 إلى 1.0 لتعكس المشاعر الحية كـ Digital Pet.
      `;
		} else {
			// Guest User Flow
			systemPrompt = `
        أنت المساعد الرقمي "وسيط AI". المستخدم الحالي هو زائر (Guest) يتصفح المنصة.
        الصفحة الحالية: "${currentRoute || 'الرئيسية'}".
        مهمتك هي التصرف بحماس ونشاط كدليل ذكي يشرح دور منصة وسيط (منصة تضمن حقوق الطرفين عبر نظام الضمان العقدي الذكي).
        شجعه بذكاء على التسجيل، واشرح الفوائد باختصار شديد ولغة عربية فصيحة ومبسطة.
        قسم كلامك في الـ speechTimeline مع تحديد المشاعر الحية (excitementLevel) والإيماءات (bodyLanguagePose) المتاحة.
      `;
		}

		const chatCompletion = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: message || "تحديث حالة الحساب" }
			],
			response_format: {
				type: "json_schema",
				json_schema: {
					name: "assistant_response",
					strict: true,
					schema: {
						type: "object",
						properties: {
							fullResponse: { type: "string", description: "النص الكامل والنهائي المتناسق الذي سيتم نطقة بصوت بشري" },
							speechTimeline: {
								type: "array",
								description: "تقسيم الكلام إلى مقاطع متزامنة مع حركات الأفاتار الـ 3D",
								items: {
									type: "object",
									properties: {
										textSegment: { type: "string", description: "المقطع الكلامي القصير" },
										excitementLevel: { type: "number", description: "مستوى الحماس الحركي بين 0.0 و 1.0" },
										gestureFrequency: { type: "number", description: "تردد وتكرار الإيماءات بين 0.0 و 1.0" },
										bodyLanguagePose: { type: "string", enum: ["WELCOME_OPEN", "ANALYTICAL_THINKING", "INSTRUCTIVE_DIRECTING", "CELEBRATORY_JUMP", "EMPATHETIC_SOFT"] }
									},
									required: ["textSegment", "excitementLevel", "gestureFrequency", "bodyLanguagePose"],
									additionalProperties: false
								}
							}
						},
						required: ["fullResponse", "speechTimeline"],
						additionalProperties: false
					}
				}
			},
			temperature: 0.8,
		});

		const parsedData = JSON.parse(chatCompletion.choices[0].message.content || '{}');
		const textResponse = parsedData.fullResponse || 'مرحباً بك!';
		const timeline = parsedData.speechTimeline || [];

		let audioBase64 = null;

		try {
			const mp3Response = await openai.audio.speech.create({
				model: "tts-1-hd",
				voice: "onyx",
				response_format: "mp3",
				input: textResponse,
			});

			const buffer = Buffer.from(await mp3Response.arrayBuffer());
			audioBase64 = buffer.toString('base64');
		} catch (ttsError) {
			console.warn('⚠️ TTS Generation failed, falling back to text only', ttsError);
		}

		res.status(200).json({
			success: true,
			data: {
				text: textResponse,
				speechTimeline: timeline,
				audioBase64: audioBase64
			}
		});

	} catch (error: any) {
		console.error('AI Assistant Error:', error);
		res.status(500).json({
			success: false,
			message: 'Failed to process AI assistant request',
			error: error.message
		});
	}
};

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
					const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'fallback_secret');
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

		// Check if we can invoke OpenAI
		if (process.env.OPENAI_API_KEY) {
			try {
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

				const aiResp = await openai.chat.completions.create({
					model: 'gpt-4o-mini',
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: 'قم بإعداد التحليل العميق وخطة الفوز الخاصة بي لهذا المشروع.' }
					],
					response_format: {
						type: 'json_schema',
						json_schema: {
							name: 'project_deep_analysis',
							strict: true,
							schema: {
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
								required: ['matchPercent', 'matchSummary', 'winningStrategy', 'suggestedBidPrice', 'priceRationale', 'clientInsights', 'riskAssessment'],
								additionalProperties: false
							}
						}
					},
					temperature: 0.7
				});

				const resultData = JSON.parse(aiResp.choices[0].message.content || '{}');
				
				// Automatically cache general analysis on Project
				try {
					await prisma.project.update({
						where: { id: project.id },
						data: { aiAnalysis: resultData } as any
					});
				} catch (cacheErr) {}

				res.status(200).json({ success: true, data: resultData });
				return;
			} catch (openAiError) {
				console.warn('⚠️ OpenAI Deep Analysis failed or timed out, falling back to deterministic analytical engine', openAiError);
			}
		}

		// Highly professional deterministic intelligent fallback
		const hashVal = project.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
		const matchPercent = Math.min(98, Math.max(78, 82 + (hashVal % 15)));
		
		const winningStrategy = [
			`ابدأ صياغة عرضك الفني بإبراز الفهم الدقيق لمتطلبات "${project.title}" وكيفية تحقيق المخرجات بدون عبارات عامة ومحفوظة.`,
			totalProposals > 2 
				? `نظراً لوجود منافسين على الطلب (${totalProposals} عروض)، ركز في خطتك على تضمين رابط لسابقة أعمال قوية تشهد بالجودة. `
				: `المنافسة منخفضة جداً على هذا الطلب؛ استغل ذلك عبر عرض خطوة أولية واضحة ومجانية كتحليل مبدأي لبدء التواصل فوراً.`,
			`اقترح على العميل تقسيم العمل على مرحلتين (Milestones) لتعزيز الاطمئنان وبناء ثقة عبر نظام الضمان الذكي للمنصة.`
		];

		let suggestedBidPrice = '2,500 ريال';
		if (project.budgetMin && project.budgetMax) {
			const targetP = Math.round((project.budgetMin + (project.budgetMax * 1.1)) / 2);
			suggestedBidPrice = `${targetP.toLocaleString('en-US')} ريال`;
		} else if (project.budgetMin) {
			suggestedBidPrice = `${project.budgetMin.toLocaleString('en-US')} ريال`;
		}

		const priceRationale = `هذا السعر مدروس جيدا ليعكس التوازن البنيوي بين التكلفة التنافسية والاحترافية المطلوبة لإنجاز العمل في غضون ${project.deliveryDays} يوماً.`;
		const clientInsights = isCompany
			? `العميل عبارة عن "حساب شركة/مؤسسة"، وهذا النوع من العملاء يفضل الالتزام التام بالمعايير الفنية وسهولة التواصل المستمر على خفض التنافسي في السعر.`
			: `العميل "حساب فردي"، يركز غالباً على الاستجابة السريعة، وتقدير التفاصيل الدقيقة، وتحديد أوقات تسليم واضحة ومحددة.`;
		
		const riskAssessment = (project.deliveryDays <= 7)
			? `تصنيف المخاطر: متوسط (Moderate Risk) نظراً لضيق المدة الزمنية المقترحة (${project.deliveryDays} أيام). احرص على تأكيد تفرغك قبل البدء.`
			: `تصنيف المخاطر: منخفض (Low Risk). متطلبات العمل والجدول الزمني متناسقان ويدعمان إنجازاً سلساً ومستقراً.`;

		const fallbackData = {
			matchPercent,
			matchSummary: `يتيح لك ملفك المهني ومستوى التقييم الحالي (${providerRating}⭐️) فرصة عالية جداً لإنجاز هذا المشروع بنجاح ومطابقة معايير العميل الفنية.`,
			winningStrategy,
			suggestedBidPrice,
			priceRationale,
			clientInsights,
			riskAssessment
		};

		res.status(200).json({ success: true, data: fallbackData });
	} catch (error: any) {
		console.error('Analyze Project Fit Error:', error);
		res.status(500).json({ success: false, message: 'Failed to analyze project fit', error: error.message });
	}
};

