import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { AccreditationStatus, SpecialtyVerificationStatus } from '@prisma/client';
import { specialtyService } from './specialty.service';

// The samples a provider attaches in the onboarding wizard (step 5) are stored as PortfolioItem rows titled «نموذج أعمال - <specialty>».
// This service turns each one into a REAL AccreditationSample (MANUAL_REVIEW = waiting for the admin) linked to the provider's ProviderSpecialty,
// so the admin queue (/admin/accreditation/samples) sees it. Idempotent: dedupe on (providerSpecialtyId + title). It never approves anything
// and never reads isPassed (the later POST /provider/accreditation flow keeps its own isPassed rule).

export const ONBOARDING_SAMPLE_TITLE_PREFIX = 'نموذج أعمال - ';

type Db = typeof prisma;

export async function ensureOnboardingAccreditationSamples(profileId: string, db: Db = prisma): Promise<{ created: number; updated: number }> {
	const items = await db.portfolioItem.findMany({ where: { providerProfileId: profileId, title: { startsWith: ONBOARDING_SAMPLE_TITLE_PREFIX } }, select: { title: true, description: true, coverImage: true, projectUrl: true, tags: true } });
	if (!items.length) return { created: 0, updated: 0 };

	await specialtyService.syncProviderSpecialtiesFromProfile(profileId, db);
	const rows = await db.providerSpecialty.findMany({ where: { providerProfileId: profileId, isActive: true }, select: { id: true, status: true, specialty: { select: { name: true, nameAr: true, nameEn: true } } } });
	if (!rows.length) return { created: 0, updated: 0 };
	const norm = (s?: string | null) => (s ?? '').trim();

	// group the portfolio items per (specialty, title): several items of one specialty become ONE sample (first real description, all attachments)
	const groups = new Map<string, { providerSpecialtyId: string; title: string; description: string; projectUrl: string | null; attachments: string[] }>();
	for (const item of items) {
		const specName = norm(item.title.slice(ONBOARDING_SAMPLE_TITLE_PREFIX.length));
		let row = rows.find(r => [r.specialty?.nameAr, r.specialty?.name, r.specialty?.nameEn].some(n => norm(n) && norm(n) === specName));
		if (!row && rows.length === 1) row = rows[0]; // a single chosen specialty: the sample can only belong to it
		if (!row) continue;
		const description = norm(item.description);
		// the wizard stores the work FILE url in `description` and the proof files in `tags`: both are evidence the admin must be able to open
		const attachments = [...new Set([...(/^https?:\/\//i.test(description) ? [description] : []), ...(item.tags ?? []), ...(item.coverImage ? [item.coverImage] : [])].filter(Boolean))];
		if (!description && !attachments.length && !item.projectUrl) continue; // nothing to review
		const key = `${row.id}::${item.title}`;
		const g = groups.get(key);
		if (!g) groups.set(key, { providerSpecialtyId: row.id, title: item.title, description, projectUrl: item.projectUrl ?? null, attachments });
		else {
			if (!g.description) g.description = description;
			if (!g.projectUrl) g.projectUrl = item.projectUrl ?? null;
			g.attachments = [...new Set([...g.attachments, ...attachments])];
		}
	}

	let created = 0; let updated = 0;
	for (const g of groups.values()) {
		const existing = await db.accreditationSample.findFirst({ where: { providerProfileId: profileId, providerSpecialtyId: g.providerSpecialtyId, title: g.title }, select: { id: true, status: true, description: true, attachments: true, projectUrl: true } });
		if (existing) {
			// still waiting for the admin: a re-save with better content refreshes it; a decided sample is never touched
			const changed = existing.description !== g.description || existing.projectUrl !== g.projectUrl || existing.attachments.join('|') !== g.attachments.join('|');
			if (existing.status === AccreditationStatus.MANUAL_REVIEW && changed) {
				await db.accreditationSample.update({ where: { id: existing.id }, data: { description: g.description, projectUrl: g.projectUrl, attachments: g.attachments } });
				updated += 1;
			}
			continue;
		}
		await db.accreditationSample.create({
			data: { providerProfileId: profileId, providerSpecialtyId: g.providerSpecialtyId, title: g.title, description: g.description, projectUrl: g.projectUrl, githubUrl: null, technologiesUsed: [], attachments: g.attachments, status: AccreditationStatus.MANUAL_REVIEW }
		});
		created += 1;
		// the specialty now waits for the admin: it enters the same review queue the admin decision endpoint reads (nothing is approved here)
		const row = rows.find(r => r.id === g.providerSpecialtyId);
		if (row && ([SpecialtyVerificationStatus.PENDING_PROOF, SpecialtyVerificationStatus.PENDING_AUDIT, SpecialtyVerificationStatus.PENDING_TEST, SpecialtyVerificationStatus.TEST_REQUIRED] as string[]).includes(row.status)) {
			await db.providerSpecialty.updateMany({ where: { id: row.id, status: row.status }, data: { status: SpecialtyVerificationStatus.UNDER_AI_REVIEW } });
			row.status = SpecialtyVerificationStatus.UNDER_AI_REVIEW;
		}
	}
	return { created, updated };
}

/** Best-effort wrapper for the call sites that must never fail because of this (the save / the test result already succeeded). */
export async function tryEnsureOnboardingAccreditationSamples(profileId: string): Promise<void> {
	try { await ensureOnboardingAccreditationSamples(profileId); } catch (error: any) { logger.error(`[OnboardingAccreditation] could not persist onboarding samples (profileId=${profileId}): ${error?.message}`); }
}
