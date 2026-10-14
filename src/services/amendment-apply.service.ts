import { AmendmentRequesterRole, AmendmentStatus, AmendmentType, ContractStatus, EscrowStatus, LogCategory, LogStatus, ProjectStageStatus } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { isV2Escrow } from '../utils/escrow-commission';
import { round2 } from '../utils/money';
import { hasActiveDispute } from './amendment-dispute-guard';

// Making an approved amendment EFFECTIVE (docs/proposals/amendment-effects.md, "simplest variant").
// `applyAmendment(tx, amendment, actor)` is the ONE place that changes the contract / escrow / stages / wallet for an amendment; both respond paths
// (client answering a provider request, provider answering a client request) call it inside their own transaction. Everything below either happens
// completely or the transaction aborts (any AppError thrown here rolls the whole transaction back and leaves the amendment PENDING).

export const AMENDMENT_TOPUP = 'AMENDMENT_TOPUP';
export const AMENDMENT_REFUND = 'AMENDMENT_REFUND';
export const MIN_STAGE_AMOUNT = 0.01;
/** How long a client's funding authorization stays valid. Never an open-ended permission to debit: after this the client must authorize again. */
export const FUNDING_AUTHORIZATION_TTL_MS = 15 * 60 * 1000;

/** The contract terms an authorization is bound to. ANY applied amendment (scope, price or duration) changes it and so voids earlier authorizations. */
export const termsFingerprint = (c: { termsVersion?: number | null; price: number; durationDays: number }) => `${c.termsVersion ?? 1}|${round2(Number(c.price))}|${c.durationDays}`;

const EPS = 0.005;
const EDITABLE_MONEY_STATUSES: ProjectStageStatus[] = [ProjectStageStatus.PENDING, ProjectStageStatus.IN_PROGRESS];
const UNRELEASED_STATUSES: ProjectStageStatus[] = [ProjectStageStatus.PENDING, ProjectStageStatus.IN_PROGRESS, ProjectStageStatus.SUBMITTED, ProjectStageStatus.REVISION_REQUESTED];

export type AmendmentToApply = {
	id: string;
	projectId: string;
	contractId: string;
	clientId: string;
	providerId: string;
	requestedByRole: AmendmentRequesterRole | 'CLIENT' | 'PROVIDER';
	type: AmendmentType | string;
	title: string;
	description: string | null;
	budgetDelta: number | null;
	durationDeltaDays: number | null;
	fundingAuthorizedAt?: Date | null;
	fundingAuthorizedAmount?: number | null;
	fundingAuthorizedTerms?: string | null;
};

export type AmendmentActor = {
	id: string;
	role: 'CLIENT' | 'PROVIDER';
	/** Provider-raised increase: the client's payment OTP row (already verified outside the transaction) — consumed inside the transaction. */
	paymentOtpId?: string | null;
};

export type AppliedAmendment = {
	priceBefore: number;
	priceAfter: number;
	durationBefore: number;
	durationAfter: number;
	walletDelta: number;
	addedStageId: string | null;
	termsVersion: number | null;
	budgetDelta: number;
	durationDeltaDays: number;
};

/** The parts of an amendment that actually take effect, decided by its TYPE (a description on a BUDGET/DURATION request is only the reason). */
export function effectiveParts(a: Pick<AmendmentToApply, 'type' | 'budgetDelta' | 'durationDeltaDays' | 'description'>) {
	const type = String(a.type);
	const budget = type === 'BUDGET' || type === 'MIXED' ? round2(Number(a.budgetDelta) || 0) : 0;
	const days = type === 'DURATION' || type === 'MIXED' ? Math.trunc(Number(a.durationDeltaDays) || 0) : 0;
	const addendum = (type === 'SCOPE' || type === 'MIXED') && a.description?.trim() ? a.description.trim() : null;
	return { budget, days, addendum };
}

const fail = (message: string, status = 409, details?: any[]) => new AppError(message, status, details);

const stagesAddUp = (stages: Array<{ stepOrder: number; amount: number; percentage: number }>, price: number) => {
	if (!stages.length || !(price > 0)) return false;
	const orders = stages.map(s => s.stepOrder);
	if (new Set(orders).size !== orders.length) return false;
	const amount = stages.reduce((sum, s) => sum + Number(s.amount), 0);
	const pct = stages.reduce((sum, s) => sum + Number(s.percentage), 0);
	return Number.isFinite(amount) && Number.isFinite(pct) && Math.abs(amount - price) <= 0.01 && Math.abs(pct - 100) <= 0.01;
};

export async function applyAmendment(tx: any, amendment: AmendmentToApply, actor: AmendmentActor): Promise<AppliedAmendment> {
	const now = new Date();
	const { budget, days, addendum } = effectiveParts(amendment);
	const raisedByClient = String(amendment.requestedByRole) === 'CLIENT';
	// The answering side is always the OTHER one than the requester (the respond paths already enforce it; re-checked here as the last line of defence).
	if ((raisedByClient && actor.role !== 'PROVIDER') || (!raisedByClient && actor.role !== 'CLIENT')) throw fail('لا يمكنك الرد على طلب تعديل رفعته أنت', 403);
	if (actor.id !== (actor.role === 'CLIENT' ? amendment.clientId : amendment.providerId)) throw fail('طلب التعديل غير موجود أو لا تملك صلاحية الوصول إليه', 403);

	// 1) Lock the contract row FIRST (same lock order as stage approval: contract, then stages / escrow) and require ACTIVE.
	const locked = await tx.contract.updateMany({ where: { id: amendment.contractId, status: ContractStatus.ACTIVE }, data: { updatedAt: now } });
	if (locked.count !== 1) throw fail('لا يمكن تطبيق التعديل: العقد غير نشط');

	// 2) Claim the amendment: only ONE caller can flip PENDING -> APPROVED (double click / two simultaneous approvals match zero rows afterwards).
	const claimed = await tx.projectAmendment.updateMany({
		where: {
			id: amendment.id,
			status: AmendmentStatus.PENDING_OTHER_PARTY,
			requestedByRole: raisedByClient ? AmendmentRequesterRole.CLIENT : AmendmentRequesterRole.PROVIDER,
			...(actor.role === 'CLIENT' ? { clientId: actor.id } : { providerId: actor.id })
		},
		data: { status: AmendmentStatus.APPROVED, respondedAt: now, appliedAt: now }
	});
	if (claimed.count !== 1) throw fail('تم الرد على طلب التعديل هذا مسبقًا');

	// 3) Refusal rules.
	if (await hasActiveDispute(amendment.projectId, tx)) throw fail('لا يمكن تطبيق التعديل أثناء وجود نزاع مفتوح على المشروع');
	const contract = await tx.contract.findUnique({ where: { id: amendment.contractId } });
	const escrow = await tx.escrow.findUnique({ where: { projectId: amendment.projectId } });
	if (!contract || contract.status !== ContractStatus.ACTIVE) throw fail('لا يمكن تطبيق التعديل: العقد غير نشط');
	if (!escrow || escrow.status !== EscrowStatus.HELD) throw fail('لا يمكن تطبيق التعديل: ضمان المشروع غير محجوز');
	const needsMoney = budget !== 0;
	const needsSchedule = needsMoney || days !== 0;
	if (needsMoney && (!isV2Escrow(escrow) || escrow.providerCommissionRateSnapshot == null)) {
		throw fail('لا يمكن تعديل ميزانية عقد قديم قبل سياسة الرسوم الجديدة. تواصل مع الدعم.');
	}
	if (needsMoney && Math.abs(escrow.amount - contract.price) > 0.01) throw fail('لا يمكن تطبيق التعديل: مبلغ الضمان لا يطابق سعر العقد، تواصل مع الدعم');

	// 4) Funding authorization for an INCREASE. Never debit without it.
	if (budget > 0) {
		const terms = termsFingerprint(contract);
		if (raisedByClient) {
			const at = amendment.fundingAuthorizedAt ? new Date(amendment.fundingAuthorizedAt).getTime() : null;
			if (at == null || !(Math.abs(Number(amendment.fundingAuthorizedAmount) - budget) <= EPS)) throw fail('لم يعتمد العميل دفع هذه الزيادة بعد (رمز التحقق مطلوب منه)');
			if (now.getTime() - at > FUNDING_AUTHORIZATION_TTL_MS) throw fail('انتهت صلاحية تفويض العميل لدفع هذه الزيادة (15 دقيقة). يلزم تفويض جديد برمز تحقق جديد.');
			if (amendment.fundingAuthorizedTerms !== terms) throw fail('تغيّرت شروط العقد بعد تفويض الدفع، فبطل التفويض. يلزم تفويض جديد.');
		} else {
			if (!actor.paymentOtpId) throw fail('اعتماد الدفع برمز التحقق مطلوب لزيادة الميزانية', 400);
			const otpRow = await tx.otpVerification.findFirst({ where: { id: actor.paymentOtpId, userId: amendment.clientId } });
			if (!otpRow) throw fail('رمز اعتماد الدفع استُخدم أو انتهى، اطلب رمزًا جديدًا');
			if ((otpRow.context as any)?.terms !== terms) throw fail('تغيّرت شروط العقد بعد إصدار رمز الدفع، فبطل. اطلب رمزًا جديدًا.');
			const consumed = await tx.otpVerification.deleteMany({ where: { id: actor.paymentOtpId, userId: amendment.clientId } });
			if (consumed.count !== 1) throw fail('رمز اعتماد الدفع استُخدم أو انتهى، اطلب رمزًا جديدًا');
		}
	}

	// 5) Stages (must already add up to the contract; an inconsistent plan is never silently patched).
	const stages: any[] = needsSchedule ? await tx.projectStage.findMany({ where: { contractId: contract.id }, orderBy: { stepOrder: 'asc' }, include: { deliveries: { select: { id: true } } } }) : [];
	if (needsSchedule) {
		if (!stagesAddUp(stages, contract.price)) throw fail('جدول مراحل العقد غير متسق مع سعره، لا يمكن تطبيق التعديل');
		if (!stages.some(s => UNRELEASED_STATUSES.includes(s.status))) throw fail('لا توجد مراحل غير مُفرَجة لتطبيق التعديل عليها');
	}

	const priceBefore = contract.price;
	const durationBefore = contract.durationDays;
	const priceAfter = round2(priceBefore + budget);
	const durationAfter = durationBefore + days;
	let walletDelta = 0;
	let addedStageId: string | null = null;
	let phasesCount = contract.phasesCount;
	const stageNotes: string[] = [];
	// Per-stage working copies so the percentages and the days can be settled once at the end.
	const work = stages.map(s => ({ id: s.id, stepOrder: s.stepOrder, status: s.status as ProjectStageStatus, amount: s.amount as number, days: s.days as number, percentage: s.percentage as number, deliveries: (s.deliveries ?? []).length, dirtyAmount: false, dirtyDays: false, isNew: false }));
	let newStageDays = 0;

	// 6) Money.
	if (budget > 0) {
		const debited = await tx.user.updateMany({ where: { id: amendment.clientId, walletBalance: { gte: budget } }, data: { walletBalance: { decrement: budget } } });
		if (debited.count !== 1) {
			const wallet = await tx.user.findUnique({ where: { id: amendment.clientId }, select: { walletBalance: true } });
			const available = Number(wallet?.walletBalance || 0);
			throw fail('رصيد المحفظة غير كافٍ لتمويل زيادة الميزانية، اشحن المحفظة ثم أعد المحاولة', 409, [{ required: budget, available, shortfall: Math.max(0, round2(budget - available)) }]);
		}
		walletDelta = -budget;
		await tx.walletTransaction.create({ data: { userId: amendment.clientId, type: AMENDMENT_TOPUP, amount: -budget, currency: 'USD', status: 'COMPLETED', paymentMethod: 'WALLET', referenceId: amendment.id, description: `زيادة ميزانية العقد: ${amendment.title}`, metadata: { amendmentId: amendment.id, contractId: contract.id, projectId: amendment.projectId } } });
	} else if (budget < 0) {
		const cut = round2(-budget);
		// Never below what was already released (gross), and only from the unreleased balance.
		if (priceAfter + EPS < round2(escrow.releasedAmount)) throw fail('لا يمكن خفض السعر عن المبلغ المُفرَج بالفعل من الضمان');
		// Which stages are affected: unreleased stages with no delivery yet (PENDING / IN_PROGRESS), taken from the LAST one backwards, each keeping at least 0.01.
		let remaining = cut;
		for (const s of [...work].reverse()) {
			if (remaining <= EPS) break;
			if (!EDITABLE_MONEY_STATUSES.includes(s.status) || s.deliveries > 0) continue;
			const take = Math.min(remaining, round2(s.amount - MIN_STAGE_AMOUNT));
			if (take <= 0) continue;
			s.amount = round2(s.amount - take);
			s.dirtyAmount = true;
			remaining = round2(remaining - take);
		}
		if (remaining > EPS) throw fail('لا تكفي المراحل غير المسلَّمة لاستيعاب هذا الخفض (المراحل المسلَّمة أو المعتمدة لا تُعدَّل)');
		await tx.user.update({ where: { id: amendment.clientId }, data: { walletBalance: { increment: cut } } });
		walletDelta = cut;
		await tx.walletTransaction.create({ data: { userId: amendment.clientId, type: AMENDMENT_REFUND, amount: cut, currency: 'USD', status: 'COMPLETED', paymentMethod: 'WALLET', referenceId: amendment.id, description: `استرداد خفض ميزانية العقد: ${amendment.title}`, metadata: { amendmentId: amendment.id, contractId: contract.id, projectId: amendment.projectId } } });
	}
	if (budget !== 0) {
		// Escrow: guarded on its previous amount, so a concurrent change makes this match nothing (aborts, nothing applied).
		const escrowTo = round2(escrow.amount + budget);
		const e = await tx.escrow.updateMany({ where: { id: escrow.id, status: EscrowStatus.HELD, amount: escrow.amount, releasedAmount: escrow.releasedAmount }, data: { amount: escrowTo } });
		if (e.count !== 1) throw fail('تغيّر ضمان المشروع أثناء التطبيق، أعد المحاولة');
	}

	// 7) Duration (no money): the day delta goes on the new stage when there is one, else on the unreleased stages (last first); the sum of the stage days moves by exactly the delta.
	if (days !== 0) {
		if (durationAfter < 1) throw fail('لا يمكن أن تقل مدة العقد عن يوم واحد');
		if (days < 0) {
			const elapsed = contract.signedAt ? Math.max(0, Math.ceil((now.getTime() - new Date(contract.signedAt).getTime()) / 86400000)) : 0;
			if (durationAfter < elapsed) throw fail('لا يمكن تقليص المدة إلى أقل من الأيام المنقضية من العقد');
		}
	}
	if (budget > 0) {
		const nextOrder = Math.max(0, ...work.map(s => s.stepOrder)) + 1;
		newStageDays = days > 0 ? days : 0;
		const created = await tx.projectStage.create({ data: { contractId: contract.id, stepOrder: nextOrder, title: `تعديل: ${amendment.title}`.slice(0, 200), description: amendment.description?.trim() || 'مرحلة إضافية ناتجة عن تعديل معتمد على العقد', days: newStageDays, percentage: 0, amount: budget, status: ProjectStageStatus.PENDING, amendmentId: amendment.id } });
		addedStageId = created.id;
		phasesCount = work.length + 1;
		work.push({ id: created.id, stepOrder: nextOrder, status: ProjectStageStatus.PENDING, amount: budget, days: newStageDays, percentage: 0, deliveries: 0, dirtyAmount: false, dirtyDays: false, isNew: true });
	}
	if (days > 0 && !addedStageId) {
		const target = [...work].reverse().find(s => UNRELEASED_STATUSES.includes(s.status));
		if (!target) throw fail('لا توجد مرحلة غير مُفرَجة لإضافة أيام التعديل إليها');
		target.days += days;
		target.dirtyDays = true;
	}
	if (days < 0) {
		let remainingDays = -days;
		for (const s of [...work].reverse()) {
			if (remainingDays <= 0) break;
			if (!UNRELEASED_STATUSES.includes(s.status) || s.isNew) continue;
			const take = Math.min(remainingDays, Math.max(0, s.days - 1));
			if (take <= 0) continue;
			s.days -= take;
			s.dirtyDays = true;
			remainingDays -= take;
		}
		if (remainingDays > 0) throw fail('لا تكفي أيام المراحل غير المُفرَجة لاستيعاب تقليص المدة');
	}

	// 8) Persist stage changes (guarded: an amount edit only on a stage that is still PENDING / IN_PROGRESS with the amount we read; days on any unreleased stage).
	for (const s of work) {
		if (s.isNew) continue;
		if (s.dirtyAmount) {
			const original = stages.find(x => x.id === s.id)!;
			const r = await tx.projectStage.updateMany({ where: { id: s.id, status: { in: EDITABLE_MONEY_STATUSES }, amount: original.amount }, data: { amount: s.amount } });
			if (r.count !== 1) throw fail('تغيّرت حالة إحدى المراحل أثناء التطبيق، أعد المحاولة');
		}
		if (s.dirtyDays) {
			const r = await tx.projectStage.updateMany({ where: { id: s.id, status: { in: UNRELEASED_STATUSES } }, data: { days: s.days } });
			if (r.count !== 1) throw fail('تغيّرت حالة إحدى المراحل أثناء التطبيق، أعد المحاولة');
		}
	}
	// Percentages are display metadata: approved stages keep theirs; the unreleased ones are re-split so the total stays 100.
	if (budget !== 0) {
		const approvedPct = work.filter(s => s.status === ProjectStageStatus.APPROVED).reduce((sum, s) => sum + s.percentage, 0);
		const open = work.filter(s => s.status !== ProjectStageStatus.APPROVED);
		let left = round2(100 - approvedPct);
		open.forEach((s, i) => {
			const pct = i === open.length - 1 ? left : round2((s.amount / priceAfter) * 100);
			left = round2(left - pct);
			if (Math.abs(pct - s.percentage) > 1e-9 || s.isNew) {
				s.percentage = pct;
				stageNotes.push(s.id);
			}
		});
		for (const s of open) {
			if (!stageNotes.includes(s.id)) continue;
			const r = await tx.projectStage.updateMany({ where: { id: s.id, status: { not: ProjectStageStatus.APPROVED } }, data: { percentage: s.percentage } });
			if (r.count !== 1) throw fail('تغيّرت حالة إحدى المراحل أثناء التطبيق، أعد المحاولة');
		}
	}

	// 9) Scope addendum: versioned terms.
	let termsVersion: number | null = null;
	if (addendum) {
		termsVersion = (contract.termsVersion || 1) + 1;
		await tx.contractTermsVersion.create({ data: { contractId: contract.id, version: termsVersion, addendumText: addendum, amendmentId: amendment.id } });
	}

	// 10) The contract itself (guarded on the values we read).
	const contractUpdate = await tx.contract.updateMany({
		where: { id: contract.id, status: ContractStatus.ACTIVE, price: priceBefore, durationDays: durationBefore },
		data: { price: priceAfter, durationDays: durationAfter, phasesCount, ...(termsVersion ? { termsVersion } : {}) }
	});
	if (contractUpdate.count !== 1) throw fail('تغيّر العقد أثناء التطبيق، أعد المحاولة');
	// The terms just changed: every other pending request loses its funding authorization (it was bound to the previous terms).
	await tx.projectAmendment.updateMany({ where: { contractId: contract.id, id: { not: amendment.id }, status: AmendmentStatus.PENDING_OTHER_PARTY }, data: { fundingAuthorizedAt: null, fundingAuthorizedAmount: null, fundingAuthorizedTerms: null } });

	// 11) Safety net: contract, escrow and stages must agree afterwards, or everything rolls back.
	if (needsMoney) {
		const finalStages = await tx.projectStage.findMany({ where: { contractId: contract.id } });
		const finalEscrow = await tx.escrow.findUnique({ where: { id: escrow.id } });
		if (!stagesAddUp(finalStages, priceAfter) || Math.abs(Number(finalEscrow?.amount) - priceAfter) > 0.01) throw fail('تعذّر تطبيق التعديل: العقد والضمان والمراحل غير متطابقة');
	}

	const summary: AppliedAmendment = { priceBefore, priceAfter, durationBefore, durationAfter, walletDelta, addedStageId, termsVersion, budgetDelta: budget, durationDeltaDays: days };
	await tx.projectAmendment.update({ where: { id: amendment.id }, data: { priceBefore, priceAfter, durationBefore, durationAfter, addedStageId } });

	// 12) Audit trail for both parties (same transaction).
	const auditBase = { category: LogCategory.SYSTEM_AUDIT, status: LogStatus.COMPLETED, statusText: 'مكتمل بنجاح', source: 'USER', eventType: 'AMENDMENT_APPLIED', severity: 'INFO' };
	const meta = { amendmentId: amendment.id, projectId: amendment.projectId, contractId: contract.id, type: String(amendment.type), priceBefore, priceAfter, durationBefore, durationAfter, walletDelta, addedStageId, termsVersion, currency: 'USD', appliedById: actor.id, appliedByRole: actor.role };
	for (const userId of [amendment.clientId, amendment.providerId]) {
		await tx.accountAuditLog.create({ data: { ...auditBase, userId, title: 'تطبيق تعديل على العقد', actionText: `طُبّق التعديل «${amendment.title}» على العقد`, summary: `طُبّق تعديل معتمد من الطرفين: السعر ${priceBefore} → ${priceAfter} دولار، المدة ${durationBefore} → ${durationAfter} يومًا.`, metaData: meta, beforeData: { price: priceBefore, durationDays: durationBefore }, afterData: { price: priceAfter, durationDays: durationAfter } } });
	}
	return summary;
}
