import { Request, Response, NextFunction } from 'express';
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
				select: { points: true, currentLevelIndex: true }
			}),
			// latest projects & proposals (top 4 combined activity)
			providerOverviewService.getLatestProviderActivity(providerId),
			// intelligent AI semantic matching projects (top 4 matches with AI match score)
			providerOverviewService.getAiMatchingProjects(providerId)
		]);

		const availableEarnings = wallet.summary.availableBalance;
		const monthlyEarnings = wallet.summary.releasedThisMonth;
		const totalEscrowAmount = wallet.summary.escrowBalance;
		
		const providerRating = providerProfile?.rating && providerProfile.rating !== 5.0 ? providerProfile.rating : 0;
		const humanRating = providerProfile?.rating && providerProfile.rating !== 5.0 ? providerProfile.rating : 0;
		const aiRating = 0; // Strict DB Mode: No mock AI rating
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
					profileCompletionPercent,
					profileSetupCompleted,
					setupTestCompleted,
					hasApprovedSpecialties,
					currentLevel,
					currentPoints,
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
				await tx.projectProposal.updateMany({ where: { projectId: targetProjectId, providerId }, data: { status: ProposalStatus.ACCEPTED } });
				await tx.proposal.updateMany({ where: { OR: [{ projectId: targetProjectId }, { clientRequestId: targetProjectId }], providerId }, data: { status: ProposalStatus.ACCEPTED } });
				await tx.project.updateMany({ where: { id: targetProjectId }, data: { status: ProjectStatus.IN_PROGRESS, providerId } });
				await tx.clientRequest.updateMany({ where: { id: targetProjectId }, data: { status: 'IN_PROGRESS' } });
				return updated;
			});
		
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
				stages: { orderBy: { stepOrder: 'asc' } },
				client: {
					select: {
						firstName: true,
						lastName: true
					}
				}
			},
			orderBy: { createdAt: 'desc' }
		});

		// Map them to the format expected by the frontend
		const data = contracts.map(c => {
			const project = c.project;
			const clientName = `${c.client.firstName || 'عميل'} ${c.client.lastName || ''}`.trim();
			
			// Determine status logic
			let status: 'wait' | 'run' | 'late' = 'wait';
			let statusLabel = 'بانتظار بدء المشروع';
			const approvedStages = c.stages.filter(stage => stage.status === 'APPROVED');
			const currentStage = c.stages.find(stage => ['IN_PROGRESS', 'SUBMITTED', 'REVISION_REQUESTED'].includes(stage.status));
			const progress = Math.min(100, Math.round(approvedStages.reduce((sum, stage) => sum + stage.percentage, 0)));
			const elapsedDays = Math.max(0, Math.floor((Date.now() - (c.signedAt || c.createdAt).getTime()) / 86400000));
			const daysLeft = Math.max(0, c.durationDays - elapsedDays);
			
			if (project.status === 'AWAITING_DELIVERY' || currentStage?.status === 'SUBMITTED') {
				status = 'wait';
				statusLabel = 'بانتظار رد العميل';
			} else if (c.status === 'ACTIVE') {
				status = 'run';
				statusLabel = 'قيد التنفيذ';
			} else if (c.status === 'PENDING_PAYMENT') {
				status = 'wait';
				statusLabel = 'بانتظار الإيداع';
			}
			if (c.status === 'ACTIVE' && daysLeft === 0 && progress < 100) { status = 'late'; statusLabel = 'متأخر'; }

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
				progress,
				providerName: clientName, // "providerName" in frontend interface actually represents the other party (client)
				providerInitial: clientName.charAt(0) || 'ع',
				providerAvatarColor: color,
				currentStage: c.status === 'PENDING_PAYMENT' ? 'بانتظار إيداع الضمان للبدء' : (currentStage?.title || 'بانتظار بدء المرحلة التالية'),
				escrowAmount: `${Math.max(0, c.price - (project.escrow?.releasedAmount || 0)).toLocaleString('en-US')} $`,
				rawPrice: Math.max(0, c.price - (project.escrow?.releasedAmount || 0)),
				escrowLabel: c.status === 'PENDING_PAYMENT' ? 'بانتظار الإيداع' : 'مستحق لي',
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

// POST /api/provider/projects/:id/stages/:stageId/ai-review
// Advisory-only — same read-only review a client can request for the same
// delivery, never approves/rejects it and never touches status or escrow.
// On any Gemini failure this returns an honest 502, not a fabricated
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

// Batch 8 — advisory-only Gemini project health analysis (Contract
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
				project: true,
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

			let status: 'done' | 'cancel' | 'arch' = 'done';
			if (isCancel) status = 'cancel';
			else if (isArch) status = 'arch';

			const clientName = `${c.client?.firstName || 'عميل'} ${c.client?.lastName || ''}`.trim();
			const displayId = `PRJ-${p.id.substring(0, 4).toUpperCase()}`;

			const dateObj = c.signedAt || c.createdAt;
			const dateFormatted = new Date(dateObj).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' });

			archivedList.push({
				id: c.projectId || c.id,
				displayId,
				title: p.title,
				clientName: clientName || 'عميل وسيط AI',
				value: `${c.price.toLocaleString()} $`,
				date: status === 'done' ? `أُغلق ${dateFormatted}` : (status === 'cancel' ? `ملغى ${dateFormatted}` : `مؤرشف ${dateFormatted}`),
				status,
				icon: status === 'done' ? 'check' : (status === 'cancel' ? 'list' : 'doc')
			});
		}

		// Process standalone projects
		for (const p of projects) {
			if (p.status !== ProjectStatus.COMPLETED && p.status !== ProjectStatus.DISPUTED) {
				continue;
			}

			const status: 'done' | 'cancel' | 'arch' = p.status === ProjectStatus.COMPLETED ? 'done' : 'arch';
			const clientName = `${p.client?.firstName || 'عميل'} ${p.client?.lastName || ''}`.trim();
			const displayId = `PRJ-${p.id.substring(0, 4).toUpperCase()}`;
			const dateFormatted = new Date(p.updatedAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' });
			const budgetVal = p.budgetFixed || p.budgetMin || p.budgetMax || 0;

			archivedList.push({
				id: p.id,
				displayId,
				title: p.title,
				clientName: clientName || 'عميل وسيط AI',
				value: `${budgetVal.toLocaleString()} $`,
				date: status === 'done' ? `أُغلق ${dateFormatted}` : `مؤرشف ${dateFormatted}`,
				status,
				icon: status === 'done' ? 'check' : 'doc'
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
				value: `${(prop.totalPrice || projectBudget).toLocaleString()} $`,
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
