import { providerInvoicesService } from '../services/provider-invoices.service';
import { providerSalesService } from '../services/provider-sales.service';
import { levelInfo } from '../utils/level-info';
import { providerProfileService } from '../services/provider-profile.service';
import { Request, Response, NextFunction } from 'express';
import { contractDeliveryState, listStatus } from '../utils/delivery-state';
import { prisma } from '../config/db';
import { ProjectStatus, ProposalStatus, EscrowStatus, ContractStatus, Project } from '@prisma/client';
import { createHash } from 'crypto';
import { AppError } from '../utils/app-error';
import { proposalService } from '../services/proposal.service';
import { providerOverviewService } from '../services/provider-overview.service';
import { accreditationService } from '../services/accreditation.service';
import { projectProgressService } from '../services/project-progress.service';
import { providerFinanceService } from '../services/provider-finance.service';
import { resolveActiveRoleDisplayFields } from '../utils/role-display-resolver';
import { providerDeliveriesService } from '../services/provider-deliveries.service';
import { computeClientAiOfferRating } from '../services/client-ai-offer-rating';
import { settledProjectIds, SETTLED_LABEL_AR } from '../services/settlement-state.service';
import { listLifecycles } from '../services/project-lifecycle.service';
import { clientNotifications, clientNotificationFor } from '../services/client-notifications.service';
import { formatMoney } from '../utils/currency';
import { providerFeePreviewService } from '../services/provider-fee-preview.service';
import { buildProviderContractView, providerTermsDigest } from '../utils/contract-terms';

export const getProviderStatistics = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) {
			return res.status(401).json({ success: false, message: 'غير مصرح' });
		}

		const twoDaysAgo = new Date();
		twoDaysAgo.setHours(twoDaysAgo.getHours() - 48);

		const [
			activeProjectsCount,
			pendingOffersCount,
			negotiationOffersCount,
			pendingClientApprovalCount,
			clientReviewsCount,
			wallet,
			providerProfile,
			gamification,
			latestActivity,
			aiMatchingProjects
		] = await Promise.all([
			// activeProjectsCount
			prisma.project.count({
				where: { providerId, status: ProjectStatus.IN_PROGRESS }
			}),
			// pendingOffersCount
			prisma.proposal.count({
				where: { providerId, status: ProposalStatus.PENDING }
			}),
			// negotiationOffersCount
			prisma.proposal.count({
				where: { providerId, status: ProposalStatus.UNDER_NEGOTIATION }
			}),
			// pendingClientApprovalCount
			prisma.project.count({
				where: { providerId, status: ProjectStatus.PENDING_APPROVAL }
			}),
			// ProviderProfile.rating defaults to 5.0 in the schema, so "has a rating" is decided by REAL client reviews, never by the value:
			// a genuine 5.0 stays 5.0 and a provider with no reviews has no rating (null).
			prisma.review.count({ where: { providerId, reviewerRole: 'CLIENT' } }),
			// Same financial source used by the wallet; includes partial stage releases.
			providerFinanceService.getWallet(providerId),
			// profile & user
			prisma.providerProfile.findUnique({
				where: { userId: providerId },
				include: {
					user: true,
					providerSpecialties: {
						where: { isActive: true, status: 'APPROVED' }
					}
				}
			}),
			// provider progression (Phase 3C source of truth for currentPoints/currentLevel — see gamification.service.ts LEVEL_MATRIX)
			prisma.providerGamification.findUnique({
				where: { providerId },
				select: { points: true, currentLevelIndex: true, currentCommission: true }
			}),
			// latest projects & proposals (top 4 combined activity)
			providerOverviewService.getLatestProviderActivity(providerId),
			// intelligent AI semantic matching projects (top 4 matches with AI match score)
			providerOverviewService.getAiMatchingProjects(providerId)
		]);

		const availableEarnings = wallet.summary.availableBalance;
		const monthlyEarnings = wallet.summary.releasedThisMonth;
		const totalEscrowAmount = wallet.summary.escrowBalance;
		
		const storedRating = providerProfile?.rating;
		const hasRating = clientReviewsCount > 0 && typeof storedRating === 'number' && Number.isFinite(storedRating) && storedRating > 0;
		const providerRating: number | null = hasRating ? storedRating! : null;
		const humanRating: number | null = providerRating;
		// "تقييم الذكاء الاصطناعي": the average of the REAL WaseetAI quality scores stored on this provider's own proposals (stars out of 5);
		// null (never 0) when no proposal was scored.
		let aiOfferRating = computeClientAiOfferRating([]);
		try {
			const scoredProposals = await prisma.proposal.findMany({ where: { providerId, aiMatchScore: { not: null } }, select: { aiMatchScore: true, createdAt: true } });
			aiOfferRating = computeClientAiOfferRating(scoredProposals);
		} catch { /* no AI rating rather than a wrong one */ }
		const aiRating = aiOfferRating.aiRating;
		const profileSetupCompleted = providerProfile?.isProfileSetupComplete === true;
		const setupTestCompleted = providerProfile?.setupTestStatus === 'COMPLETED';
		const hasApprovedSpecialties = (providerProfile?.providerSpecialties?.length || 0) > 0;

		// Phase 3C: name/avatar/completion come from ProviderProfile, and
		// currentPoints/currentLevel from the provider's own gamification system
		// (ProviderGamification + LEVEL_MATRIX) — never from the legacy User
		// columns unless the provider genuinely has neither row yet.
		const { firstName, lastName, profileCompletionPercent, currentLevel, currentPoints } = resolveActiveRoleDisplayFields({
			activeRole: 'PROVIDER',
			legacy: {
				firstName: providerProfile?.user?.firstName || 'مقدم',
				lastName: providerProfile?.user?.lastName || 'الخدمة',
				avatarUrl: providerProfile?.user?.avatarUrl ?? null,
				profileCompletionPercent: providerProfile?.user?.profileCompletionPercent || 0,
				currentLevel: providerProfile?.user?.currentLevel || 'مستكشف - المستوى 1',
				currentPoints: providerProfile?.user?.currentPoints || 0,
				pointsToNextLevel: providerProfile?.user?.pointsToNextLevel || 100
			},
			providerProfile,
			providerGamification: gamification
		});

		// Count only eligible, specialty-approved matches created in the past 48 hours.
		const newOffersCount = hasApprovedSpecialties
			? aiMatchingProjects.filter(project => new Date(project.createdAt).getTime() >= twoDaysAgo.getTime()).length
			: 0;

		res.status(200).json({
			success: true,
			message: 'تم استرجاع الإحصائيات بنجاح',
			data: {
				summary: {
					activeProjectsCount,
					newOffersCount,
					pendingOffersCount,
					negotiationOffersCount,
					pendingClientApprovalCount,
					availableEarnings,
					monthlyEarnings,
					totalEscrowAmount,
					providerRating,
					humanRating,
					aiRating,
					aiRatingSource: aiOfferRating.aiRatingSource,
					aiRatingUpdatedAt: aiOfferRating.aiRatingUpdatedAt,
					aiRatedOffersCount: aiOfferRating.aiRatedOffersCount,
					profileCompletionPercent,
					profileSetupCompleted,
					setupTestCompleted,
					hasApprovedSpecialties,
					currentLevel,
					// The shared level payload (name, percent, colours from the single ladder), same shape every dashboard receives.
					levelInfo: levelInfo('PROVIDER', gamification?.currentLevelIndex),
					currentPoints,
					// Real values only (the dashboard badge is built from them): the profile's KYC status, and the commission percentage stored for
					// the provider's current level (ProviderGamification.currentCommission). null when the row / value does not exist.
					kycStatus: providerProfile?.kycStatus ?? null,
					// The badge must say what the profile data page says: the SAME derivation (identityVerification), never the raw kycStatus alone
					// (an approved document with a stale KYC "PENDING" used to show "under review" next to "verified").
					identityVerification: await providerProfileService.getIdentityVerification(providerId),
					commissionPercent: typeof gamification?.currentCommission === 'number' ? gamification.currentCommission : null,
					firstName,
					lastName
				},
				topSteps: {},
				latestProjects: latestActivity,
				latestProposals: latestActivity,
				aiMatchingProjects
			}
		});
	} catch (error) {
		next(error);
	}
};

export const getProviderOffers = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) {
			return res.status(401).json({ success: false, message: 'غير مصرح' });
		}

		const { status, clientType, search, sortBy, page, limit } = req.query;

		const result = await proposalService.getProviderOffers(providerId, {
			status: status as string,
			clientType: clientType as string,
			search: search as string,
			sortBy: sortBy as string,
			page: page ? Number(page) : undefined,
			limit: limit ? Number(limit) : undefined
		});

		res.status(200).json({
			success: true,
			total: result.total,
			page: result.page,
			aiBannerText: result.aiBannerText,
			counts: result.counts,
			data: result.data
		});
	} catch (error) {
		next(error);
	}
};

export const getProviderOfferById = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) {
			return res.status(401).json({ success: false, message: 'غير مصرح' });
		}
		const data = await proposalService.getProviderOfferById(providerId, String(req.params.id));
		res.status(200).json({ success: true, data });
	} catch (error) {
		next(error);
	}
};

export const getEligibleAccreditationSpecialties = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) {
			return res.status(401).json({ success: false, message: 'غير مصرح' });
		}
		
		const result = await accreditationService.getEligibleSpecialties(providerId);
		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};

export const getPassedSpecialties = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) {
			return res.status(401).json({ success: false, message: 'غير مصرح' });
		}
		
		const result = await accreditationService.getPassedSpecialties(providerId);
		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};
	export const signContract = async (req: Request, res: Response, next: NextFunction) => {
		try {
			const providerId = (req as any).user?.id;
			if (!providerId) {
				return res.status(401).json({ success: false, message: 'غير مصرح' });
			}
			const offerId = req.params.id as string;
			const { agreedTerms } = req.body;
			if (agreedTerms?.accepted !== true) {
				return res.status(400).json({ success: false, message: 'يجب الموافقة الصريحة على نسخة العقد الحالية' });
			}
			
			// Find the proposal
			let proposal: any = await prisma.proposal.findUnique({
				where: { id: offerId }
			});
			let isLegacy = true;
			
			if (!proposal) {
				proposal = await prisma.projectProposal.findUnique({
					where: { id: offerId }
				});
				isLegacy = false;
			}
			
			if (!proposal || proposal.providerId !== providerId) {
				return res.status(404).json({ success: false, message: 'العرض غير موجود' });
			}
	
			if (proposal.status !== ProposalStatus.PENDING_SIGNATURE) {
				return res.status(409).json({ success: false, message: 'العرض غير جاهز للتوقيع أو تم توقيعه مسبقاً' });
			}

			// Get actual project ID depending on legacy or new model
			const targetProjectId = isLegacy ? proposal.clientRequestId : proposal.projectId;

			if (!targetProjectId) {
				return res.status(404).json({ success: false, message: 'المشروع غير موجود' });
			}
			
			const price = isLegacy ? proposal.price : proposal.totalPrice;
			const durationDays = isLegacy ? proposal.deliveryDays : proposal.deliveryDays;
			
			// Try finding the client ID from Project or ClientRequest
			let clientId = '';
			const projectData = await prisma.project.findUnique({ where: { id: targetProjectId } });
			
			if (projectData) {
				clientId = projectData.clientId;
			} else {
				const reqData = await prisma.clientRequest.findUnique({
					where: { id: targetProjectId },
					include: { clientProfile: true }
				});
				if (reqData) clientId = reqData.clientProfile.userId;
			}

			if (!clientId) {
				return res.status(404).json({ success: false, message: 'تعذر العثور على صاحب المشروع' });
			}

			const [pendingContract, heldEscrow] = await Promise.all([
				prisma.contract.findFirst({ where: { projectId: targetProjectId, providerId, status: ContractStatus.PENDING_PROVIDER_SIGNATURE } }),
				prisma.escrow.findFirst({ where: { projectId: targetProjectId, status: EscrowStatus.HELD } })
			]);
			if (!pendingContract) return res.status(409).json({ success: false, message: 'العقد غير موقع من العميل أو غير جاهز لتوقيع مقدم الخدمة' });
			if (!heldEscrow) return res.status(409).json({ success: false, message: 'لا يمكن بدء المشروع قبل تأكيد تمويل الضمان' });

			// The provider signs the terms HE WAS SHOWN (price, currency, the commission frozen on the escrow and what it leaves him): the page echoes the fingerprint of what it displayed. A missing fingerprint
			// means the terms were never shown and confirmed; a different one means they changed after they were shown - both are refused, and the current terms come back so they can be shown again.
			const shownDigest = typeof agreedTerms?.termsDigest === 'string' ? agreedTerms.termsDigest : '';
			if (!shownDigest) return res.status(400).json({ success: false, code: 'TERMS_CONFIRMATION_REQUIRED', message: 'راجع شروط العقد (السعر والعمولة وصافي ما تستلمه) ثم أكّدها قبل التوقيع' });
			if (shownDigest !== providerTermsDigest(pendingContract, heldEscrow)) {
				return res.status(409).json({ success: false, code: 'TERMS_CHANGED', message: 'تغيّرت شروط العقد بعد أن عُرضت عليك. راجع السعر والعمولة والصافي الحاليين ثم أكّد من جديد', data: { contract: buildProviderContractView(pendingContract, heldEscrow) } });
			}

			const signedAt = new Date();
			const signatureHash = createHash('sha256')
				.update(`${pendingContract.id}:${providerId}:${pendingContract.termsVersion}:${signedAt.toISOString()}`)
				.digest('hex');
			const contract = await prisma.$transaction(async tx => {
				// Phase 4 — conditional transition (row-locked): a second concurrent
				// signature, or a contract that left PENDING_PROVIDER_SIGNATURE in the
				// meantime, matches zero rows and nothing below is written.
				const transitioned = await tx.contract.updateMany({
					where: { id: pendingContract.id, providerId, status: ContractStatus.PENDING_PROVIDER_SIGNATURE },
					data: {
						providerSignedAt: signedAt,
						providerSignatureHash: signatureHash,
						status: ContractStatus.ACTIVE,
						signedAt
					}
				});
				if (transitioned.count !== 1) throw new AppError('تم توقيع هذا العقد مسبقاً أو تغيّرت حالته', 409);
				const escrowStillHeld = await tx.escrow.count({ where: { projectId: targetProjectId, status: EscrowStatus.HELD } });
				if (escrowStillHeld !== 1) throw new AppError('لا يمكن بدء المشروع قبل تأكيد تمويل الضمان', 409);
				const updated = await tx.contract.findUniqueOrThrow({ where: { id: pendingContract.id } });
				// the same check against the rows as they are INSIDE the transaction (the contract row was just locked by the transition): a change that slipped in after the pre-check still rolls everything back
				const escrowNow = await tx.escrow.findFirstOrThrow({ where: { projectId: targetProjectId, status: EscrowStatus.HELD } });
				if (shownDigest !== providerTermsDigest(updated, escrowNow)) throw new AppError('تغيّرت شروط العقد بعد أن عُرضت عليك. راجع السعر والعمولة والصافي الحاليين ثم أكّد من جديد', 409, [{ contract: buildProviderContractView(updated, escrowNow) }], 'TERMS_CHANGED');
				await tx.projectProposal.updateMany({ where: { projectId: targetProjectId, providerId }, data: { status: ProposalStatus.ACCEPTED } });
				await tx.proposal.updateMany({ where: { OR: [{ projectId: targetProjectId }, { clientRequestId: targetProjectId }], providerId }, data: { status: ProposalStatus.ACCEPTED } });
				await tx.project.updateMany({ where: { id: targetProjectId }, data: { status: ProjectStatus.IN_PROGRESS, providerId } });
				await tx.clientRequest.updateMany({ where: { id: targetProjectId }, data: { status: 'IN_PROGRESS' } });
				return updated;
			});

		// The client learns the project started: stored + delivered once, only after the signing transaction committed (a failure here never undoes the signature).
		await clientNotifications.send(clientNotificationFor.contractSigned({ clientId: contract.clientId, projectId: contract.projectId, projectTitle: projectData?.title ?? null }));
		res.status(200).json({ success: true, message: 'تم التوقيع بنجاح، المشروع الآن قيد التنفيذ', data: contract });
	} catch (error) {
		next(error);
	}
};

export const getActiveProjects = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) {
			return res.status(401).json({ success: false, message: 'غير مصرح' });
		}

		// Fetch all contracts where providerId matches, and status is ACTIVE, PENDING_PAYMENT, or similar
		const contracts = await prisma.contract.findMany({
			where: { providerId, status: { in: ['ACTIVE', 'PENDING_PAYMENT', 'PENDING_PROVIDER_SIGNATURE'] } },
			include: {
				project: { include: { escrow: true } },
				stages: { orderBy: { stepOrder: 'asc' }, include: { deliveries: { select: { status: true }, orderBy: { submittedAt: 'asc' } } } },
				client: {
					select: {
						firstName: true,
						lastName: true
					}
				}
			},
			orderBy: { createdAt: 'desc' }
		});
		// A contract that came through offer negotiation + signing may not have its stage rows yet: the progress endpoint creates them lazily, so the list must resolve them the
		// same way (one helper) or it would show «لم تُجهَّز مراحل المشروع» and canUploadDelivery:false for a project that is actually deliverable.
		for (const c of contracts) {
			if (c.status === 'ACTIVE' && c.stages.length === 0) {
				await projectProgressService.ensureStages(c.id);
				c.stages = await prisma.projectStage.findMany({ where: { contractId: c.id }, orderBy: { stepOrder: 'asc' }, include: { deliveries: { select: { status: true }, orderBy: { submittedAt: 'asc' } } } });
			}
		}
		// A project with an open dispute says so (the newest open one wins).
		const openDisputes = contracts.length ? await prisma.dispute.findMany({
			where: { projectId: { in: contracts.map(c => c.projectId) }, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
			select: { projectId: true, status: true }, orderBy: { createdAt: 'asc' }
		}) : [];
		const disputeByProject = new Map(openDisputes.map(d => [d.projectId as string, d.status as string]));

		// Map them to the format expected by the frontend
		const data = contracts.map(c => {
			const project = c.project;
			const clientName = `${c.client.firstName || 'عميل'} ${c.client.lastName || ''}`.trim();
			
			const approvedStages = c.stages.filter(stage => stage.status === 'APPROVED');
			const currentStage = c.stages.find(stage => ['IN_PROGRESS', 'SUBMITTED', 'REVISION_REQUESTED'].includes(stage.status));
			const progress = Math.min(100, Math.round(approvedStages.reduce((sum, stage) => sum + stage.percentage, 0)));
			const elapsedDays = Math.max(0, Math.floor((Date.now() - (c.signedAt || c.createdAt).getTime()) / 86400000));
			const daysLeft = Math.max(0, c.durationDays - elapsedDays);
			// Every state below comes from the real contract / stage / escrow rows (see utils/delivery-state.ts); nothing is assumed.
			const state = contractDeliveryState(c.status, c.stages, project.escrow, disputeByProject.get(project.id) || null);
			const { status, statusLabel } = listStatus(state, daysLeft, progress);

			// Generate random color from a predefined list based on ID hash
			const colors = ['#2ECC8A', '#2BD4C7', '#06B6A2', '#5DA0FF', '#A56BE0', '#FFB400'];
			const colorIndex = c.id.charCodeAt(0) % colors.length;
			const color = colors[colorIndex];

			return {
				id: c.id,
				projectId: project.id,
				title: project.title,
				status,
				statusLabel,
				...state,
				// The dispute freeze (approval / release only) is shown by the list too; delivery stays allowed.
				hasActiveDispute: disputeByProject.has(project.id),
				operationalStatus: c.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING_START',
				closedBySettlement: false,
				progress,
				providerName: clientName, // "providerName" in frontend interface actually represents the other party (client)
				providerInitial: clientName.charAt(0) || 'ع',
				providerAvatarColor: color,
				currentStage: c.status === 'PENDING_PAYMENT' ? 'بانتظار إيداع الضمان للبدء'
					: c.status !== 'ACTIVE' ? 'لم تبدأ المراحل بعد'
					: (currentStage?.title || (c.stages.length && approvedStages.length === c.stages.length ? 'اعتُمدت كل المراحل' : 'لم تُجهَّز مراحل المشروع بعد')),
				// Only a funded escrow is "held". An unfunded contract shows its value, never a lock.
				escrowAmount: formatMoney(state.escrowFunded ? state.heldAmount : c.price, c.currency),
				currency: c.currency,
				rawPrice: state.heldAmount,
				escrowLabel: state.escrowFunded ? 'محتجز بالضمان' : 'قيمة العقد (غير ممولة بعد)',
				contractRef: `CT-${c.id.slice(0, 6).toUpperCase()}`,
				approvedStagesCount: approvedStages.length,
				stagesCount: c.stages.length,
				daysLeft,
				meta: c.stages.length ? `${approvedStages.length} من ${c.stages.length} مراحل · ${daysLeft} يومًا متبقية` : `عقد لمدة ${c.durationDays} يوم`
			};
		});

		res.status(200).json({
			success: true,
			data
		});

	} catch (error) {
		next(error);
	}
};

export const getProjectProgress = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		const projectId = req.params.id as string;

		if (!providerId) {
			return res.status(401).json({ success: false, message: 'غير مصرح' });
		}

		const data = await projectProgressService.getProjectProgress(providerId, projectId);
		res.status(200).json({ success: true, data });

	} catch (error) {
		next(error);
	}
};

export const submitStageDelivery = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		console.log('[submitStageDelivery] received body:', JSON.stringify({ note: req.body?.note?.slice(0, 50), files: req.body?.files, filesCount: Array.isArray(req.body?.files) ? req.body.files.length : 0 }));
		const data = await projectProgressService.submitDelivery(providerId, req.params.id as string, req.params.stageId as string, req.body?.note, req.body?.files);
		console.log('[submitStageDelivery] created delivery files:', JSON.stringify((data as any)?.files));
		res.status(201).json({ success: true, message: 'تم إرسال المرحلة للعميل للمراجعة', data });
	} catch (error) { next(error); }
};

// POST /api/provider/projects/:projectId/stages/:stageId/deliveries/files — multipart field "files" (max 5 x 25MB).
// Stores the files for real (Cloudinary) after checking the stage belongs to this provider's ACTIVE contract and is open for a delivery;
// returns the file descriptors to send back in POST .../deliveries. Nothing is written to the database here.
export const uploadStageDeliveryFiles = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		const files = (Array.isArray(req.files) ? req.files : []) as Express.Multer.File[];
		const data = await projectProgressService.uploadDeliveryFiles(providerId, req.params.projectId as string, req.params.stageId as string, files);
		res.status(201).json({ success: true, message: 'تم رفع الملفات', data: { files: data } });
	} catch (error) { next(error); }
};

// POST /api/provider/projects/:id/stages/:stageId/ai-review
// Advisory-only — same read-only review a client can request for the same
// delivery, never approves/rejects it and never touches status or escrow.
// The AI review runs through the internal LlmClient (AppError 503 when the model is unavailable); any other failure returns an honest 502, not a fabricated
// review; submitStageDelivery above is completely unaffected either way.
export const getDeliveryAiReview = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		const data = await projectProgressService.getDeliveryAiReview(providerId, req.params.id as string, req.params.stageId as string);
		res.status(200).json({ success: true, data });
	} catch (error: any) {
		if (error instanceof AppError) return next(error);
		console.error('[DeliveryAiReview] Failed:', error?.code || error?.message);
		res.status(502).json({
			success: false,
			message: 'تعذر إنشاء المراجعة الاستشارية بالذكاء الاصطناعي حالياً. يمكنك متابعة مراجعة التسليم واتخاذ القرار يدوياً كالمعتاد.'
		});
	}
};

// Batch 8 — advisory-only project health analysis (Contract
// Monitoring / Project Health / Predictive Delay Risk / Predictive Dispute
// Risk — one real feature). Read-only, never approves/rejects/releases
// funds/changes status. Same honest-unavailable-on-failure pattern as
// getDeliveryAiReview above.
export const getProjectHealthAnalysis = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		const data = await projectProgressService.getProjectHealthAnalysis(providerId, req.params.id as string);
		res.status(200).json({ success: true, data });
	} catch (error: any) {
		if (error instanceof AppError) return next(error);
		console.error('[ProjectHealthAnalysis] Failed:', error?.code || error?.message);
		res.status(502).json({
			success: false,
			message: 'تعذر إجراء تحليل صحة المشروع بالذكاء الاصطناعي حالياً. يمكنك متابعة المشروع كالمعتاد.'
		});
	}
};

export const getProviderFeePreview = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		const data = await providerFeePreviewService.preview(providerId, req.query.price, req.query.currency);
		res.status(200).json({ success: true, data });
	} catch (error) { next(error); }
};

export const getProviderWallet = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		const data = await providerFinanceService.getWallet(providerId);
		res.status(200).json({ success: true, data });
	} catch (error) { next(error); }
};

export const getProviderTransactions = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		const data = await providerFinanceService.getTransactions(providerId);
		res.status(200).json({ success: true, data });
	} catch (error) { next(error); }
};

export const getArchivedProjects = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) {
			return res.status(401).json({ success: false, message: 'غير مصرح' });
		}

		// 1. Fetch contracts for this provider
		const contracts = await prisma.contract.findMany({
			where: { providerId },
			include: {
				project: { include: { escrow: true } },
				client: {
					select: {
						firstName: true,
						lastName: true
					}
				}
			},
			orderBy: { updatedAt: 'desc' }
		});

		// 2. Fetch standalone projects assigned to provider
		const contractProjectIds = contracts.map(c => c.projectId);
		const projects = await prisma.project.findMany({
			where: {
				providerId,
				id: { notIn: contractProjectIds }
			},
			include: {
				client: {
					select: {
						firstName: true,
						lastName: true
					}
				}
			},
			orderBy: { updatedAt: 'desc' }
		});

		// 3. Fetch proposals that were rejected or cancelled
		const proposals = await prisma.projectProposal.findMany({
			where: {
				providerId,
				status: { in: [ProposalStatus.REJECTED, ProposalStatus.CANCELLED] }
			},
			include: {
				project: {
					include: {
						client: {
							select: {
								firstName: true,
								lastName: true
							}
						}
					}
				}
			},
			orderBy: { updatedAt: 'desc' }
		});

		const archivedList: any[] = [];
		// Projects closed by an admin financial dispute settlement: shown as such, never as "completed".
		const settledIds = await settledProjectIds([...contracts.map(c => c.projectId), ...projects.map(p => p.id)]);
		// ONE lifecycle per archived contract: the same state and the same money as the detail pages (a settled project is its own end state, never "completed").
		const lifecycleMap = await listLifecycles(contracts.map(c => ({ projectId: c.projectId, contractStatus: c.status, price: c.price, escrow: c.project?.escrow ?? null })), { db: prisma });
		const settledExtra = (id: string) => {
			const lc = lifecycleMap.get(id);
			const base = settledIds.has(id) ? { settled: true, statusLabel: SETTLED_LABEL_AR } : {};
			return lc ? { ...base, operationalStatus: lc.operationalStatus, closureReason: lc.closureReason, completedByDelivery: lc.completedByDelivery, closedBySettlement: lc.closedBySettlement, hasActiveDispute: lc.hasActiveDispute, financial: lc.financial } : base;
		};

		// Filter contracts that are completed, cancelled, or archived/disputed
		for (const c of contracts) {
			const p = c.project;
			if (!p) continue;

			const isDone = c.status === ContractStatus.COMPLETED || p.status === ProjectStatus.COMPLETED;
			const isCancel = c.status === ContractStatus.CANCELLED;
			const isArch = c.status === ContractStatus.DISPUTED || p.status === ProjectStatus.DISPUTED;

			// Only include if it belongs to completed, cancelled, or archived states
			if (!isDone && !isCancel && !isArch) {
				continue;
			}

			let status: 'done' | 'cancel' | 'arch' | 'settled' = 'done';
			if (isCancel) status = 'cancel';
			else if (isArch) status = 'arch';
			// Closed by a dispute settlement: its own state (never "done"), whatever the stored contract / project status is.
			if (settledIds.has(c.projectId)) status = 'settled';

			const clientName = `${c.client?.firstName || 'عميل'} ${c.client?.lastName || ''}`.trim();
			const displayId = `PRJ-${p.id.substring(0, 4).toUpperCase()}`;

			const dateObj = c.signedAt || c.createdAt;
			const dateFormatted = new Date(dateObj).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' });

			archivedList.push({
				id: c.projectId || c.id,
				displayId,
				title: p.title,
				clientName: clientName || 'عميل وسيط AI',
				value: formatMoney(c.price, c.currency),
				currency: c.currency,
				date: settledIds.has(c.projectId) ? `${SETTLED_LABEL_AR} ${dateFormatted}` : (status === 'done' ? `أُغلق ${dateFormatted}` : (status === 'cancel' ? `ملغى ${dateFormatted}` : `مؤرشف ${dateFormatted}`)),
				status,
				icon: status === 'done' ? 'check' : (status === 'cancel' ? 'list' : 'doc'),
				...settledExtra(c.projectId)
			});
		}

		// Process standalone projects
		for (const p of projects) {
			if (p.status !== ProjectStatus.COMPLETED && p.status !== ProjectStatus.DISPUTED) {
				continue;
			}

			const status: 'done' | 'cancel' | 'arch' | 'settled' = settledIds.has(p.id) ? 'settled' : p.status === ProjectStatus.COMPLETED ? 'done' : 'arch';
			const clientName = `${p.client?.firstName || 'عميل'} ${p.client?.lastName || ''}`.trim();
			const displayId = `PRJ-${p.id.substring(0, 4).toUpperCase()}`;
			const dateFormatted = new Date(p.updatedAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' });
			const budgetVal = p.budgetFixed || p.budgetMin || p.budgetMax || 0;

			archivedList.push({
				id: p.id,
				displayId,
				title: p.title,
				clientName: clientName || 'عميل وسيط AI',
				value: formatMoney(budgetVal, (p as { currency?: string }).currency),
				date: settledIds.has(p.id) ? `${SETTLED_LABEL_AR} ${dateFormatted}` : (status === 'done' ? `أُغلق ${dateFormatted}` : `مؤرشف ${dateFormatted}`),
				status,
				icon: status === 'done' ? 'check' : 'doc',
				...settledExtra(p.id)
			});
		}

		// Process proposals (rejected / cancelled) if not already added
		for (const prop of proposals) {
			if (!prop.project || archivedList.some(item => item.id === prop.projectId)) {
				continue;
			}

			const clientName = `${prop.project.client?.firstName || 'عميل'} ${prop.project.client?.lastName || ''}`.trim();
			const displayId = `PRJ-${prop.project.id.substring(0, 4).toUpperCase()}`;
			const dateFormatted = new Date(prop.updatedAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' });
			const projectBudget = prop.project.budgetFixed || prop.project.budgetMin || prop.project.budgetMax || 0;

			archivedList.push({
				id: prop.projectId || prop.id,
				displayId,
				title: prop.project.title,
				clientName: clientName || 'عميل وسيط AI',
				value: formatMoney(prop.totalPrice || projectBudget, (prop as { currency?: string }).currency),
				date: `ملغى قبل التعاقد (${dateFormatted})`,
				status: 'cancel',
				icon: 'list'
			});
		}

		res.status(200).json({
			success: true,
			data: archivedList
		});
	} catch (error) {
		next(error);
	}
};

// Implementation Batch 7 — real replacement for team-deliveries.ts's
// fully hardcoded "company deliveries" list. See provider-deliveries.
// service.ts for why this returns the provider's own real StageDelivery
// rows rather than a fabricated per-team-member breakdown.
export const getCompanyDeliveries = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) {
			return res.status(401).json({ success: false, message: 'غير مصرح' });
		}

		const deliveries = await providerDeliveriesService.getCompanyDeliveries(providerId);
		res.status(200).json({ success: true, data: deliveries });
	} catch (error) {
		next(error);
	}
};

export const getProviderInvoices = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		res.status(200).json({ success: true, data: await providerInvoicesService.list(providerId) });
	} catch (error) { next(error); }
};

export const getProviderInvoice = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		res.status(200).json({ success: true, data: await providerInvoicesService.get(providerId, String(req.params.id || '')) });
	} catch (error) { next(error); }
};

export const getProviderSales = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const providerId = (req as any).user?.id;
		if (!providerId) return res.status(401).json({ success: false, message: 'غير مصرح' });
		res.status(200).json({ success: true, data: await providerSalesService.getSales(providerId) });
	} catch (error) { next(error); }
};
