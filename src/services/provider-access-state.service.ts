import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { AccountType, AccreditationStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { ensureOnboardingAccreditationSamples } from './onboarding-accreditation.service';

// ONE source of truth for "may this provider open the dashboard": derived on every call from stored facts only
// (profile completeness, setup test, accreditation samples, ProviderSpecialty status). Nothing here is client-provided and nothing is cached.
// Passing the test never opens the dashboard: only >= 1 APPROVED + active ProviderSpecialty does (set by the admin).

export type ProviderAccessStateName = 'SETUP_INCOMPLETE' | 'ASSESSMENT_REQUIRED' | 'SAMPLE_REQUIRED' | 'PENDING_REVIEW' | 'COMPLETION_REQUIRED' | 'REJECTED' | 'APPROVED' | 'NOT_APPLICABLE';

/**
 * Batch B T1 (§4) entry gate, derived on the server from the state (never from the client):
 *  - SETUP: setup / test / sample missing -> only the page that completes it (no operating menus);
 *  - REVIEW: the request is under review / needs completion / was rejected -> the actions log, the needed completion, help and account, no operating services;
 *  - OPEN: approved (or a company) -> the operating dashboard. An APPROVED account adding another specialty stays OPEN.
 */
export type ProviderEntryGate = 'SETUP' | 'REVIEW' | 'OPEN';
export const entryGateOf = (state: ProviderAccessStateName): ProviderEntryGate =>
	state === 'APPROVED' || state === 'NOT_APPLICABLE' ? 'OPEN' : state === 'PENDING_REVIEW' || state === 'COMPLETION_REQUIRED' || state === 'REJECTED' ? 'REVIEW' : 'SETUP';

export const ACCESS_MESSAGES: Record<ProviderAccessStateName, string> = {
	SETUP_INCOMPLETE: 'أكمل إعداد ملفك لمتابعة اعتماد حسابك.',
	ASSESSMENT_REQUIRED: 'أكمل الاختبار لإكمال اعتماد حسابك.',
	SAMPLE_REQUIRED: 'اجتزت الاختبار، لكن يجب رفع نموذج الاعتماد لإكمال المراجعة.',
	PENDING_REVIEW: 'تم اجتياز الاختبار، ونموذج الاعتماد قيد المراجعة. ستفتح لوحة مقدم الخدمة بعد اعتماد الإدارة.',
	COMPLETION_REQUIRED: 'طلبت الإدارة استكمال بيانات طلب الاعتماد. افتح «إجراءات الحساب» لاستكماله.',
	REJECTED: 'تم رفض نموذج الاعتماد. راجع السبب وارفع نموذجاً جديداً لإعادة المراجعة.',
	APPROVED: 'تم اعتماد حسابك. يمكنك الدخول إلى لوحة مقدم الخدمة.',
	NOT_APPLICABLE: 'هذا المسار لا ينطبق على حسابات الشركات.'
};
export const DASHBOARD_LOCKED_MESSAGE = 'لوحة مقدم الخدمة تفتح بعد اعتماد نموذج الاعتماد من الإدارة';

const PENDING_SAMPLE: AccreditationStatus[] = [AccreditationStatus.MANUAL_REVIEW, AccreditationStatus.PENDING_AI_AUDIT, AccreditationStatus.AI_VERIFIED];
const REASON_MARKER = 'سبب الرفض:';

export interface ProviderAccessSpecialty {
	providerSpecialtyId: string; specialtyId: string; nameAr: string; status: string; isPassed: boolean;
	sample: { id: string; status: string; rejectionReason: string | null; submittedAt: Date } | null;
}
export interface ProviderAccessState {
	state: ProviderAccessStateName; gate: ProviderEntryGate; canAccessDashboard: boolean; message: string; reason: string | null; hasSample: boolean; specialties: ProviderAccessSpecialty[];
	/** the request waiting for the provider to complete it (COMPLETION_REQUIRED only) */
	completionSampleId?: string | null;
}

/** The admin reject appends «[مراجعة الإدارة] سبب الرفض: <reason>» to aiFeedbackAr; only that human reason is returned. */
export function extractRejectionReason(feedback?: string | null): string | null {
	if (!feedback) return null;
	const i = feedback.lastIndexOf(REASON_MARKER);
	if (i < 0) return null;
	return feedback.slice(i + REASON_MARKER.length).trim() || null;
}

const result = (state: ProviderAccessStateName, extra: Partial<ProviderAccessState> = {}): ProviderAccessState => ({
	state, gate: entryGateOf(state), canAccessDashboard: state === 'APPROVED' || state === 'NOT_APPLICABLE', message: ACCESS_MESSAGES[state], reason: null, hasSample: false, specialties: [], ...extra
});

type Db = typeof prisma;

async function load(db: Db, profileId: string) {
	return db.providerSpecialty.findMany({
		where: { providerProfileId: profileId, isActive: true },
		orderBy: { createdAt: 'asc' },
		select: {
			id: true, specialtyId: true, status: true, isPassed: true, isActive: true,
			specialty: { select: { nameAr: true, name: true } },
			accreditationSamples: { orderBy: { createdAt: 'desc' }, select: { id: true, status: true, aiFeedbackAr: true, createdAt: true } }
		}
	});
}

export const providerAccessStateService = {
	async get(userId: string, db: Db = prisma): Promise<ProviderAccessState> {
		const user = await db.user.findUnique({ where: { id: userId }, select: { accountType: true } });
		if (user?.accountType === AccountType.PROVIDER_COMPANY) return result('NOT_APPLICABLE');

		const profile = await db.providerProfile.findUnique({ where: { userId }, select: { id: true, isProfileSetupComplete: true, setupTestStatus: true } });
		if (!profile) return result('SETUP_INCOMPLETE');

		let rows = await load(db, profile.id);
		const approved = rows.some(r => r.status === SpecialtyVerificationStatus.APPROVED);
		// form not complete -> SETUP_INCOMPLETE; form complete but the test not COMPLETED -> ASSESSMENT_REQUIRED (no sample is registered before the test is completed)
		if (!approved && profile.isProfileSetupComplete !== true) return result('SETUP_INCOMPLETE', { specialties: shape(rows) });
		if (!approved && profile.setupTestStatus !== 'COMPLETED') return result('ASSESSMENT_REQUIRED', { specialties: shape(rows) });

		// lazy repair (backfill of accounts created before the onboarding sample was persisted): idempotent, never blocks the answer
		if (!approved && !rows.some(r => r.accreditationSamples.length)) {
			try {
				const r = await ensureOnboardingAccreditationSamples(profile.id, db);
				if (r.created || r.updated) rows = await load(db, profile.id);
			} catch (error: any) { logger.error(`[ProviderAccessState] lazy sample repair failed (userId=${userId}): ${error?.message}`); }
		}

		const specialties = shape(rows);
		const hasSample = rows.some(r => r.accreditationSamples.length > 0);
		if (approved) return result('APPROVED', { specialties, hasSample });

		const effective = rows.map(r => {
			const samples = r.accreditationSamples;
			// the admin asked for more data on the latest request: the provider has to act (samples are newest first)
			if (samples[0]?.status === AccreditationStatus.NEEDS_COMPLETION) return 'COMPLETION' as const;
			// a sample waiting for the admin wins (a re-submission after a rejection re-opens the review)
			if (samples.some(s => PENDING_SAMPLE.includes(s.status)) || r.status === SpecialtyVerificationStatus.UNDER_AI_REVIEW) return 'PENDING' as const;
			if (r.status === SpecialtyVerificationStatus.REJECTED) return 'REJECTED' as const;
			if (samples.length && samples.every(s => s.status === AccreditationStatus.REJECTED)) return 'REJECTED' as const;
			return 'NONE' as const;
		});
		if (effective.includes('COMPLETION')) {
			const row = rows.find(r => r.accreditationSamples[0]?.status === AccreditationStatus.NEEDS_COMPLETION);
			return result('COMPLETION_REQUIRED', { specialties, hasSample, completionSampleId: row?.accreditationSamples[0]?.id ?? null });
		}
		if (effective.includes('PENDING')) return result('PENDING_REVIEW', { specialties, hasSample });
		if (effective.includes('REJECTED')) {
			let reason: string | null = null;
			for (const s of rows.flatMap(r => r.accreditationSamples).filter(s => s.status === AccreditationStatus.REJECTED)) { reason = extractRejectionReason(s.aiFeedbackAr); if (reason) break; }
			if (!reason) {
				try {
					const log = await db.accountAuditLog.findFirst({ where: { userId, eventType: 'SPECIALTY_ADMIN_DECISION', status: 'REJECTED' }, orderBy: { createdAt: 'desc' }, select: { summary: true } });
					reason = log?.summary?.trim() || null;
				} catch { /* no reason rather than a wrong one */ }
			}
			return result('REJECTED', { specialties, hasSample, reason });
		}
		return result('SAMPLE_REQUIRED', { specialties, hasSample });
	}
};

function shape(rows: Awaited<ReturnType<typeof load>>): ProviderAccessSpecialty[] {
	return rows.map(r => {
		const s = r.accreditationSamples[0];
		return {
			providerSpecialtyId: r.id, specialtyId: r.specialtyId, nameAr: r.specialty?.nameAr || r.specialty?.name || '', status: r.status, isPassed: r.isPassed,
			sample: s ? { id: s.id, status: s.status, rejectionReason: s.status === AccreditationStatus.REJECTED ? extractRejectionReason(s.aiFeedbackAr) : null, submittedAt: s.createdAt } : null
		};
	});
}
