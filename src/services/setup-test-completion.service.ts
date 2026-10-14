import { prisma } from '../config/db';
import { logger } from '../config/logger';
import { specialtyService } from './specialty.service';
import { ensureOnboardingAccreditationSamples } from './onboarding-accreditation.service';

type Db = typeof prisma;

/**
 * The setup test is really COMPLETED here. In this order:
 *  1. the result is stored on the profile (a failure throws: the caller keeps the session so the last answer can be re-sent);
 *  2. the result is recorded on the provider's specialty rows as a FACT (taken / score / passed) — never an approval;
 *  3. the onboarding sample becomes a real AccreditationSample (MANUAL_REVIEW) and the specialty enters the admin queue.
 * Steps 2 and 3 are best-effort and loud: a failure or an empty result is logged, and the access state then says SAMPLE_REQUIRED
 * (and the lazy repair retries) — it is never silently lost, and passing the test never opens the dashboard.
 */
export async function completeSetupTest(profileId: string, score: number, passed: boolean, db: Db = prisma): Promise<{ samplesCreated: number }> {
	await db.providerProfile.update({ where: { id: profileId }, data: { setupTestScore: score, setupTestStatus: 'COMPLETED' } });
	try { await specialtyService.applySetupTestToSpecialties(profileId, score, passed, db); } catch (err: any) { logger.error(`[SetupTestCompletion] specialty write failed (profileId=${profileId}): ${err?.message}`); }
	try {
		const r = await ensureOnboardingAccreditationSamples(profileId, db);
		const existing = await db.accreditationSample.count({ where: { providerProfileId: profileId } });
		if (!existing) logger.warn(`[SetupTestCompletion] test completed but NO accreditation sample could be registered (profileId=${profileId}): no onboarding portfolio sample matches a chosen specialty. The provider will see SAMPLE_REQUIRED.`);
		return { samplesCreated: r.created };
	} catch (err: any) {
		logger.error(`[SetupTestCompletion] could not register the onboarding sample (profileId=${profileId}): ${err?.message}. The provider will see SAMPLE_REQUIRED and the access-state repair retries.`);
		return { samplesCreated: 0 };
	}
}
