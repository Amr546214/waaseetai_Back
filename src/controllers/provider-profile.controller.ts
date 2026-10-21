import { respondServiceError } from '../utils/known-service-errors';
import { updateProviderPreferencesSchema } from '../dtos/provider-preferences.dto';
import { publicKycRejectionReason, withoutInternalProviderNotes } from '../utils/provider-kyc-review';
import { Request, Response, NextFunction } from 'express';
import { AppError, fieldErrorItem } from '../utils/app-error';
import { providerProfileService } from '../services/provider-profile.service';
import { prisma } from '../config/db';
import { CONTACT_IMMUTABLE, CONTACT_IMMUTABLE_MESSAGE } from '../services/provider-profile.service';
import { getCatalogForCategoryParam, resolveSkillIdsFromCatalog } from '../services/skills-catalog.service';
import { specialtyService } from '../services/specialty.service';
import { ensureCloudinaryUrl, storeDataUriIfNeeded, storeKycFileIfNeeded } from '../utils/cloudinary-storage';
import { sanitizeText, isBlankText } from '../utils/sanitize-text';
import { assertKycFileValues, isStoredValueUnchanged } from '../utils/kyc-value-guard';
import { assertVerifiedIdentityUnchanged, identitySubmissionChanged } from '../utils/kyc-identity-guard';
import { sessionService } from '../services/session.service';
import { computeProviderCompletion } from '../utils/completion-calculators';
import { nonPaypalPayoutKeys, PAYPAL_ONLY_MESSAGE } from '../utils/client-payout-fields';
import { normalizeProviderSetupPayload, isProviderSetupComplete } from '../utils/provider-setup-payload';
import { resolveSetupPortfolio, MODEL_TITLE_PREFIX, type ResolvedPortfolioItem } from '../utils/setup-portfolio-proofs';
import { assertSetupIdentityFront, identityDocumentOnFile } from '../utils/setup-identity-required';
import { logger } from '../config/logger';
import { providerSetupEvidenceComplete } from '../utils/provider-setup-payload';

import { providerBioSuggestSchema, providerSkillsSuggestSchema, setupSkillsSchema } from '../dtos/provider-profile-suggest.dto';

export const suggestBio = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const input = providerBioSuggestSchema.safeParse(req.body ?? {});
    if (!input.success) return res.status(400).json({ success: false, message: 'بيانات الاقتراح غير صالحة' });
    res.json({ success: true, data: await providerProfileService.suggestBio(req.user.id, input.data) });
  } catch (error) { next(error); }
};

export const suggestSkills = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const input = providerSkillsSuggestSchema.safeParse(req.body ?? {});
    if (!input.success) return res.status(400).json({ success: false, message: 'بيانات الاقتراح غير صالحة' });
    res.json({ success: true, data: await providerProfileService.suggestSkills(req.user.id, input.data) });
  } catch (error) { next(error); }
};

const auditContext = (req: Request) => ({ sessionId: req.user?.sessionId, ipAddress: req.ip, device: req.get('user-agent')?.slice(0, 120) });

export const getActiveSessions = async (req: Request, res: Response) => {
	const userId = req.user?.id;
	if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
	const data = await sessionService.list(userId, req.user?.sessionId);
	res.json({ success: true, data });
};

export const revokeSession = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		await sessionService.revoke(userId, req.params.id as string, req.user?.sessionId);
		res.json({ success: true });
	} catch (error: any) {
		res.status(400).json({ success: false, message: error.message });
	}
};

const PASSWORD_ERROR_FIELDS: Record<string, Array<{ field: string; message: string }>> = {
	CURRENT_PASSWORD_INCORRECT: [{ field: 'currentPassword', message: 'كلمة المرور الحالية غير صحيحة' }],
	WEAK_PASSWORD: [{ field: 'newPassword', message: 'كلمة المرور ضعيفة: استخدم 8 أحرف على الأقل مع حرف كبير ورقم' }],
	PASSWORD_UNCHANGED: [{ field: 'newPassword', message: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية' }],
	PASSWORD_FIELDS_REQUIRED: [{ field: 'currentPassword', message: 'أدخل كلمة المرور الحالية' }, { field: 'newPassword', message: 'أدخل كلمة المرور الجديدة' }],
};

export const changePassword = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const { currentPassword, newPassword } = req.body || {};
		const data = await providerProfileService.changePassword(userId, String(currentPassword || ''), String(newPassword || ''), auditContext(req));
		res.json({ success: true, data });
	} catch (error: any) {
		const status = error.message === 'CURRENT_PASSWORD_INCORRECT' ? 401 : 400;
		// The code stays the message; `errors` names the password box it belongs under (admin "my account" and the other password forms read it).
		const where = PASSWORD_ERROR_FIELDS[error.message];
		res.status(status).json({ success: false, message: error.message, ...(where && { errors: where.map((w) => fieldErrorItem(w.field, w.message)) }) });
	}
};

export const getProfile = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) {
			return res.status(401).json({ message: 'Unauthorized' });
		}

		const profile = await providerProfileService.getProfile(userId);
		res.json(profile);
	} catch (error) {
		console.error('Error fetching profile:', error);
		res.status(500).json({ message: 'Internal server error' });
	}
};

// Free-text fields of the provider wizard: markup stripped, trimmed, length-capped (undefined / non-string stay undefined = keep stored).
const clean = (value: unknown, max: number): string | undefined => (typeof value === 'string' ? sanitizeText(value).trim().slice(0, max) : undefined);
const cleanList = (value: unknown, max: number, count: number): string[] =>
	(Array.isArray(value) ? value : []).filter((v): v is string => typeof v === 'string').map(v => sanitizeText(v).trim().slice(0, max)).filter(Boolean).slice(0, count);

export const getSetupData = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });

		const profile = await prisma.providerProfile.findUnique({
			where: { userId },
			include: { skills: { select: { name: true } }, portfolioItems: true }
		});

		// The raw `notes` column (internal / admin text) is never returned; a rejected identity review comes back as a safe reason on its own field.
		const kycRejectionReason = publicKycRejectionReason(profile?.kycStatus, profile?.notes);
		// The same identity state the profile page and the dashboard use (NOT_SUBMITTED / PENDING_REVIEW / VERIFIED / REJECTED + category), so a document sent in the setup is "under review" here too.
		let identityVerification: Awaited<ReturnType<typeof providerProfileService.getIdentityVerification>> = null;
		try { identityVerification = await providerProfileService.getIdentityVerification(userId); } catch { /* the status is extra information: the setup read never fails because of it */ }
		res.status(200).json({ success: true, data: profile ? { ...withoutInternalProviderNotes(profile), kycRejectionReason, identityVerification } : {} });
	} catch (error) {
		res.status(500).json({ message: 'Internal server error' });
	}
};

export const saveSetupData = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });

		const payload = req.body;
		const { bank, portfolio } = payload;
		// PayPal is the only financial method: a bank / IBAN / holder / wallet value is refused, never silently dropped.
		const forbiddenPayout = [...nonPaypalPayoutKeys(payload), ...nonPaypalPayoutKeys(bank)];
		if (forbiddenPayout.length) return res.status(400).json({ success: false, message: PAYPAL_ONLY_MESSAGE, errors: forbiddenPayout.map(k => ({ path: k, field: k, message: PAYPAL_ONLY_MESSAGE, code: 'custom' })) });
		// Known alternative names are mapped onto the canonical fields; an unknown field is a 400 (never accepted and silently dropped).
		const normalized = normalizeProviderSetupPayload(payload);
		if (!normalized.ok) return res.status(400).json({ success: false, message: 'بعض الحقول غير مدعومة أو غير صالحة ولم يُحفظ شيء', errors: normalized.errors });
		const { details, identity, documents, agreements, specialties } = normalized.value;
		// Business models (setup step 5): every chosen sub-specialty needs a model FILE and, for that model, at least one completed, owned, EXISTING proof of ownership
		// that is a different file (checked only when `portfolio` is sent: the wizard submission). Decided BEFORE any write; stored files are kept through their stored row.
		// `portfolio: null` (older callers) is not a submission, like an absent key.
		const wizardSubmission = portfolio !== undefined && portfolio !== null;
		let resolvedPortfolio: ResolvedPortfolioItem[] | undefined;
		if (wizardSubmission) {
			const held = await prisma.providerProfile.findUnique({ where: { userId }, select: { subSpecialties: true, portfolioItems: { select: { id: true, title: true, description: true, tags: true, coverImage: true } } } });
			resolvedPortfolio = await resolveSetupPortfolio({ userId, portfolio, chosenSubSpecs: specialties?.subSpecs ?? held?.subSpecialties ?? [], stored: (held?.portfolioItems ?? []) as any[] });
		}
		// Only the explicit ordinary save connects accepted skill names. Resolve
		// every name before any writes/uploads; never upsert taxonomy rows.
		let skillConnections: { id: string }[] | undefined;
		if (payload.skills !== undefined) {
			const parsed = setupSkillsSchema.safeParse(payload.skills);
			if (!parsed.success) return res.status(400).json({ message: 'قائمة المهارات غير صالحة' });
			// The catalog of the main specialty chosen in THIS request (or the stored one) is the only source of skills.
			const held = await prisma.providerProfile.findUnique({ where: { userId }, select: { mainSpecialty: true, skills: { select: { name: true } } } });
			skillConnections = await resolveSkillIdsFromCatalog(prisma, parsed.data, specialties?.mainSpec ?? held?.mainSpecialty, (held?.skills ?? []).map(s => s.name));
		}

		// A VERIFIED account's identity (idNumber / dob) is frozen (409); '' / null never erase a stored value.
		const storedIdentity = await prisma.providerProfile.findUnique({ where: { userId }, select: { idNumber: true, dob: true, kycStatus: true, isProfileSetupComplete: true, frontIdUrl: true, backIdUrl: true, supportingDocsUrl: true, certUrls: true, avatarUrl: true, user: { select: { avatarUrl: true } } } });
		assertVerifiedIdentityUnchanged(storedIdentity, details ?? {});

		// A value the user already has stored in these fields and re-sends unchanged is "keep", not a new link (legacy file names / public URLs would otherwise be refused on every re-save).
		const storedFileValues = [storedIdentity?.frontIdUrl, storedIdentity?.backIdUrl, storedIdentity?.supportingDocsUrl, ...(storedIdentity?.certUrls ?? [])];
		assertKycFileValues([identity?.frontId, identity?.backId, documents?.supportingDocs, ...(identity?.certs || [])], userId, storedFileValues);
		// The wizard submission needs the FRONT of the ID as a real, trusted document (stored earlier or a valid new file): a KYC status alone is never evidence. Decided before any write.
		// Identity documents on file besides the stored front: the approved account document and the ID document of a DOCUMENTS change request waiting for the admin.
		const [accountDoc, waitingDocs] = await Promise.all([
			prisma.user.findUnique({ where: { id: userId }, select: { idDocumentUrl: true } }),
			prisma.profileModificationRequest.findMany({ where: { providerId: userId, category: 'DOCUMENTS', fieldName: 'idDocumentUrl', status: 'PENDING_HUMAN_REVIEW' as any }, select: { requestedValue: true } })
		]);
		const otherStored = [accountDoc?.idDocumentUrl, ...waitingDocs.map(r => r.requestedValue)];
		if (wizardSubmission) await assertSetupIdentityFront({ userId, frontId: identity?.frontId, storedFront: storedIdentity?.frontIdUrl, otherStored });
		// For the completion decision (also on a partial save): is there really a trusted identity document? A storage outage here is "not proven", never a failed save.
		const hasIdentityDocument = await identityDocumentOnFile({ userId, storedFront: storedIdentity?.frontIdUrl, otherStored }).catch(() => false);

		// ── PHASE 1: PREPARE every file (no application row is written yet). A failure here changes nothing in the database. ──
		// Files that this request put into the storage (data: URIs) are remembered so that, if the save fails afterwards, they are REPORTED (never deleted: they can be
		// reused by a retry, and older / shared files are never touched).
		const uploaded: string[] = [];
		const prepared = async <T extends string | null | undefined>(input: unknown, run: () => Promise<T>): Promise<T> => {
			const out = await run();
			if (typeof input === 'string' && input.startsWith('data:') && out) uploaded.push(String(out));
			return out;
		};
		try {
			const [frontIdUrl, backIdUrl, supportingDocsUrl] = await Promise.all([
				prepared(identity?.frontId, () => storeKycFileIfNeeded(identity?.frontId, `waseetai/providers/${userId}/identity`, 'front-id')),
				prepared(identity?.backId, () => storeKycFileIfNeeded(identity?.backId, `waseetai/providers/${userId}/identity`, 'back-id')),
				prepared(documents?.supportingDocs, () => storeKycFileIfNeeded(documents?.supportingDocs, `waseetai/providers/${userId}/documents`, 'supporting-document'))
			]);
			const certUrls = await Promise.all((identity?.certs || []).map((url: string, index: number) =>
				prepared(url, () => storeKycFileIfNeeded(url, `waseetai/providers/${userId}/certificates`, `certificate-${index + 1}`))
			));

			// The profile photo (ProviderProfile.avatarUrl is the one canonical column): only our own storage URL or an image data URI is stored; anything else is a 400 and nothing is saved.
			// The photo already stored on the account (e.g. the Google sign-in picture) that the wizard echoes back unchanged is kept as it is: never re-validated as a new link, never rewritten.
			const avatarUnchanged = isStoredValueUnchanged(normalized.value.avatarUrl, [storedIdentity?.avatarUrl, storedIdentity?.user?.avatarUrl]);
			const avatarUrl = normalized.value.avatarUrl && !avatarUnchanged ? await prepared(normalized.value.avatarUrl, () => ensureCloudinaryUrl(normalized.value.avatarUrl, `waseetai/users/${userId}/avatar`, 'avatar')) : undefined;

			// The business-model files (data: URIs are uploaded by us) are prepared now too, so no storage work happens between the database writes.
			const preparedModels: Array<{ title: string; description: string | null; coverImage: string | null; tags: string[] }> | undefined = resolvedPortfolio
				? await Promise.all(resolvedPortfolio.map(async item => {
					const proofUrls = await Promise.all(item.proofs.map((url, index) => prepared(url, () => storeDataUriIfNeeded(url, `waseetai/providers/${userId}/portfolio`, `${item.spec}-${index + 1}`))));
					const reviewUrl = await prepared(item.review, () => storeDataUriIfNeeded(item.review, `waseetai/providers/${userId}/portfolio`, `${item.spec}-model`));
					return { title: `${MODEL_TITLE_PREFIX}${clean(item.spec, 100) ?? ''}`, description: clean(reviewUrl, 2000) ?? null, coverImage: proofUrls[0] || null, tags: proofUrls.filter(Boolean) as string[] };
				}))
				: undefined;

			// A document that really differs from the stored one is a NEW identity submission. While the admin has not decided the previous one, it is refused (409), never queued twice.
			const newFront = frontIdUrl && frontIdUrl !== storedIdentity?.frontIdUrl ? frontIdUrl : undefined;
			const newBack = backIdUrl && backIdUrl !== storedIdentity?.backIdUrl ? backIdUrl : undefined;
			// A PENDING account whose review has NO document on file (legacy state) is not "already under review": it must be able to send the missing document, otherwise it can neither complete the setup nor fix it.
			if (storedIdentity?.kycStatus === 'PENDING' && (hasIdentityDocument || !!storedIdentity?.frontIdUrl) && (newFront || newBack)) {
				throw new AppError('مستندات الهوية قيد المراجعة بالفعل. انتظر قرار الإدارة قبل إرسال مستندات جديدة.', 409);
			}
			const identityChanged = identitySubmissionChanged(storedIdentity, details ?? {}, { front: newFront, back: newBack });

			const providerData = {
				userId,
				avatarUrl: avatarUrl || undefined, // absent = keep the stored photo (a re-save never erases it)
				idNumber: details?.idNumber || undefined,
				dob: details?.dob ? new Date(details.dob) : undefined, // absent = keep the stored value (a re-save never erases it)
				country: clean(details?.country, 60),
				city: clean(details?.city, 80),
				industry: clean(details?.occupation, 100),
				// The job title the wizard collects ("occupation") is the profile headline the completion score and the public profile read:
				// one value, stored in both columns (industry kept for older readers).
				headline: typeof details?.occupation === 'string' && !isBlankText(sanitizeText(details.occupation)) ? sanitizeText(details.occupation).trim().slice(0, 100) : undefined,
				address: clean(details?.address, 500),
				bio: typeof details?.bio === 'string' ? sanitizeText(details.bio) : details?.bio,
				// Batch B T1: the legacy languages value is never touched unless the request carries it (the wizard no longer sends it: step 1 is now «مهاراتي»)
				...(Array.isArray(details?.languages) ? { languages: cleanList(details?.languages, 40, 20) } : {}),
				yearsOfExperience: normalized.value.yearsOfExperience,
				hourlyRate: normalized.value.hourlyRate,

				mainSpecialty: clean(specialties?.mainSpec, 100),
				subSpecialties: cleanList(specialties?.subSpecs, 100, 30),

				// Empty/absent = "keep what is stored" (a stored private document is not visible to the client, so a re-save must not wipe it).
				frontIdUrl: frontIdUrl || undefined,
				backIdUrl: backIdUrl || undefined,
				...(certUrls.filter(Boolean).length ? { certUrls: certUrls.filter(Boolean) as string[] } : {}),
				// isNafathVerified / kycStatus / isVerified are NEVER written from this request (AUD-FND-000048): they are read-only here and
				// change only through a real verification integration or the admin KYC decision (onboarding.service).

				supportingDocsUrl: supportingDocsUrl || undefined,
				notes: clean(documents?.notes, 1000),

				accurateAgreed: agreements?.accurate,
				termsAgreed: agreements?.terms,
				privacyAgreed: agreements?.privacy,

				// isProfileSetupComplete is decided below from what was really stored, not assumed from the POST.
				...(skillConnections !== undefined && { skills: { connect: skillConnections } })
			};

			// ── PHASE 2: ONE transaction for every database change of the request: profile, specialty rows, the setup models (ONLY the «نموذج أعمال - …» rows: the provider's
			// ordinary portfolio works are never touched), the completion figures and the review state. Any failure rolls all of it back. ──
			const updatedResult = await prisma.$transaction(async (tx) => {
				const result = await tx.providerProfile.upsert({
					where: { userId },
					create: providerData,
					// `set` on update: the saved list is exactly what was sent, so removing a skill really removes it (connect alone could never drop one)
					update: { ...providerData, ...(skillConnections !== undefined && { skills: { set: skillConnections } }) }
				});

				// The specialties chosen in the wizard become the provider's ProviderSpecialty rows (create-only, no duplicates): the model-upload / market pages read those rows.
				await specialtyService.syncProviderSpecialtiesFromProfile(result.id, tx as any);

				if (preparedModels) {
					await tx.portfolioItem.deleteMany({ where: { providerProfileId: result.id, title: { startsWith: MODEL_TITLE_PREFIX } } });
					if (preparedModels.length > 0) await tx.portfolioItem.createMany({ data: preparedModels.map(m => ({ ...m, providerProfileId: result.id })) });
				}

				// Recalculate ProviderProfile.completionPercentage from the FINAL state (after the upsert and the models just created: portfolioItems.length is a scored factor).
				const finalProfile = await tx.providerProfile.findUnique({ where: { userId }, include: { skills: true, portfolioItems: true } });
				const currentUser = await tx.user.findUnique({ where: { id: userId } });
				const completion = computeProviderCompletion({ providerProfile: finalProfile || result, user: currentUser || {} });

				// User.status is NOT touched by the setup wizard (AUD-FND-000036): it changes only through OTP activation or an admin decision.
				const updated = await tx.providerProfile.update({ where: { userId }, data: { completionPercentage: completion, isProfileSetupComplete: (isProviderSetupComplete(finalProfile) && providerSetupEvidenceComplete({ ...(finalProfile as any), hasIdentityDocument: hasIdentityDocument || !!frontIdUrl })) || (storedIdentity as any)?.isProfileSetupComplete === true } });
				// Submitting a changed, complete identity (idNumber + front + back) marks an UNVERIFIED/REJECTED profile as PENDING review;
				// a VERIFIED one is never downgraded and an unchanged re-save never re-opens a review.
				if (identityChanged) {
					await tx.providerProfile.updateMany({
						// The wizard collects the front of the ID as the required evidence (the back and the number are optional): a stored front is a complete submission.
						where: { userId, kycStatus: { in: ['UNVERIFIED', 'REJECTED'] }, frontIdUrl: { not: null } },
						data: { kycStatus: 'PENDING' }
					});
				}
				return updated;
			}, { timeout: 20_000 });

			res.status(200).json({
				success: true,
				message: 'تم حفظ البيانات بنجاح',
				data: withoutInternalProviderNotes(updatedResult)
			});
			return;
		} catch (failure) {
			// Nothing of this request was written to the database. Files that were already put into the storage are listed here, apart from the error (never deleted).
			if (uploaded.length) logger.warn(`[ProviderSetup] userId=${userId}: the save failed after ${uploaded.length} file(s) were uploaded; kept in the storage, not referenced by any row: ${uploaded.join(', ')}`);
			throw failure;
		}
	} catch (error) {
		if (error instanceof AppError) return res.status(error.statusCode).json({ success: false, message: error.message, ...(error.errors?.length ? { errors: error.errors } : {}) });
		console.error('Error saving provider setup data:', error);
		res.status(500).json({ message: 'Internal server error' });
	}
};

export const getPublicProfile = async (req: Request, res: Response) => {
	try {
		// If a providerId param is passed, we fetch for that, otherwise we fetch for the authenticated user (preview mode)
		const providerId = (req.params.providerId as string) || req.user?.id;
		if (!providerId) {
			return res.status(401).json({ message: 'Unauthorized or missing provider ID' });
		}

		const isOwner = !req.params.providerId || req.user?.id === providerId;
		const publicProfile = await providerProfileService.getPublicProfile(providerId, { isOwner });
		res.json({ success: true, data: publicProfile });
	} catch (error: any) {
		console.error('Error fetching public profile:', error);
		const statusCode = error instanceof AppError ? error.statusCode : 500;
		res.status(statusCode).json({ success: false, message: error.message || 'Internal server error' });
	}
};

export const getChangeRequests = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) {
			return res.status(401).json({ message: 'Unauthorized' });
		}
		const tabName = req.params.tabName as string;
		const requests = await providerProfileService.getChangeRequests(userId, tabName);
		res.json(requests);
	} catch (error) {
		res.status(500).json({ message: 'Error fetching change requests', error });
	}
};

export const getModificationRequests = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });

		const status = req.query.status as string;
		const result = await providerProfileService.getModificationRequests(userId, status);
		res.json({ success: true, data: result });
	} catch (error: any) {
		res.status(500).json({ success: false, message: error.message });
	}
};

export const createModificationRequest = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });

		const result = await providerProfileService.createModificationRequest(userId, req.body);
		res.json({ success: true, data: result });
	} catch (error: any) {
		if (error.message === CONTACT_IMMUTABLE) return res.status(403).json({ success: false, code: CONTACT_IMMUTABLE, message: CONTACT_IMMUTABLE_MESSAGE });
		res.status(error.message === PAYPAL_ONLY_MESSAGE ? 400 : 500).json({ success: false, message: error.message });
	}
};

export const cancelModificationRequest = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });

		const result = await providerProfileService.cancelModificationRequest(req.params.id as string, userId as string);
		res.json({ success: true, data: result });
	} catch (error: any) {
		res.status(500).json({ success: false, message: error.message });
	}
};

export const initiateSensitiveChange = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ success: false, code: 'SESSION_REQUIRED', message: 'انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.' });
		const { category, changes } = req.body || {};
		const result = await providerProfileService.initiateSensitiveChange(userId, String(category || ''), changes || {}, auditContext(req));
		res.status(201).json({ success: true, data: result });
	} catch (error: any) {
		if (error?.code === 'OTP_THROTTLED') {
			const wait = Number(error.retryAfterSeconds) || 60;
			res.setHeader('Retry-After', String(wait));
			return res.status(429).json({ success: false, code: 'OTP_THROTTLED', message: error.message, retryAfterSeconds: wait, retryAt: new Date(Date.now() + wait * 1000).toISOString() });
		}
		if (error.message === CONTACT_IMMUTABLE) return res.status(403).json({ success: false, code: CONTACT_IMMUTABLE, message: CONTACT_IMMUTABLE_MESSAGE });
		respondServiceError(res, error);
	}
};

export const verifySensitiveChange = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const { requestId, code } = req.body || {};
		if (!requestId || !/^\d{6}$/.test(String(code || ''))) {
			return res.status(400).json({ success: false, code: 'OTP_FORMAT_INVALID', message: 'أدخل رمز التحقق المكوّن من 6 أرقام كما وصلك في بريدك.', errors: [{ field: 'code', path: 'code', message: 'أدخل رمز التحقق المكوّن من 6 أرقام' }] });
		}
		const result = await providerProfileService.verifySensitiveChange(userId, String(requestId), String(code), auditContext(req));
		res.json({ success: true, data: result });
	} catch (error: any) {
		if (error.message === CONTACT_IMMUTABLE) return res.status(403).json({ success: false, code: CONTACT_IMMUTABLE, message: CONTACT_IMMUTABLE_MESSAGE });
		respondServiceError(res, error);
	}
};

export const reviewSensitiveChange = async (req: Request, res: Response) => {
	try {
		const { approved, rejectionReason } = req.body || {};
		if (typeof approved !== 'boolean') return res.status(400).json({ success: false, message: 'approved must be boolean' });
		if (rejectionReason !== undefined && rejectionReason !== null && typeof rejectionReason !== 'string') return res.status(400).json({ success: false, message: 'rejectionReason must be text' });
		const result = await providerProfileService.reviewSensitiveChange(req.params.id as string, approved, rejectionReason ?? undefined, { ...auditContext(req), actorLabel: req.user?.email });
		res.json({ success: true, data: { ...result, metadata: undefined } });
	} catch (error: any) {
		respondServiceError(res, error);
	}
};

export const getPendingSensitiveReviews = async (req: Request, res: Response) => {
	try {
		const data = await providerProfileService.getPendingSensitiveReviews(req.query.status as string | undefined);
		res.json({ success: true, data: data.map(item => ({ ...item, metadata: undefined })) });
	} catch (error: any) {
		res.status(500).json({ success: false, message: error.message });
	}
};

export const updateBasicInfo = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) {
			return res.status(401).json({ message: 'Unauthorized' });
		}

		const updatedProfile = await providerProfileService.updateBasicInfo(userId, req.body, auditContext(req));
		res.json(updatedProfile);
	} catch (error: any) {
		res.status(400).json({ message: error.message || 'Error updating basic info' });
	}
};

export const updateContactInfo = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });
		const profile = await providerProfileService.updateContactInfo(userId, req.body);
		res.json(profile);
	} catch (error: any) {
		if (error?.message === CONTACT_IMMUTABLE) return res.status(403).json({ success: false, code: CONTACT_IMMUTABLE, message: CONTACT_IMMUTABLE_MESSAGE });
		res.status(500).json({ message: 'Error updating contact info', error });
	}
};

// PayPal is the only payout destination: there is no bank info to update (the PayPal email changes only through the e-mailed code flow).
export const updateBankingInfo = async (req: Request, res: Response) => {
	const userId = req.user?.id;
	if (!userId) return res.status(401).json({ message: 'Unauthorized' });
	res.status(400).json({ success: false, message: PAYPAL_ONLY_MESSAGE });
};

export const updateDocsInfo = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });
		const profile = await providerProfileService.updateDocsInfo(userId, req.body);
		res.json(profile);
	} catch (error) {
		res.status(500).json({ message: 'Error updating docs info', error });
	}
};

export const updateSkills = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });

		const parsed = setupSkillsSchema.safeParse(req.body?.skills ?? []);
		if (!parsed.success) return res.status(400).json({ success: false, message: 'قائمة المهارات غير صالحة' });
		const updated = await providerProfileService.updateSkills(userId, parsed.data);
		res.json(updated);
	} catch (error) {
		if (error instanceof AppError) return res.status(error.statusCode).json({ success: false, message: error.message });
		console.error('Error updating skills:', error);
		res.status(500).json({ message: 'Internal server error' });
	}
};

export const addPortfolioItem = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });

		const item = await providerProfileService.addPortfolioItem(userId, req.body);
		res.status(201).json(item);
	} catch (error) {
		if (error instanceof AppError) return res.status(error.statusCode).json({ success: false, message: error.message });
		console.error('Error adding portfolio item:', error);
		res.status(500).json({ message: 'Internal server error' });
	}
};

export const updatePortfolioItem = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });

		const item = await providerProfileService.updatePortfolioItem(userId, req.params.id as string, req.body);
		res.json(item);
	} catch (error) {
		if (error instanceof AppError) return res.status(error.statusCode).json({ success: false, message: error.message });
		console.error('Error updating portfolio item:', error);
		res.status(500).json({ message: 'Internal server error' });
	}
};

export const deletePortfolioItem = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });

		await providerProfileService.deletePortfolioItem(userId, req.params.id as string);
		res.json({ message: 'Deleted successfully' });
	} catch (error) {
		if (error instanceof AppError) return res.status(error.statusCode).json({ success: false, message: error.message });
		console.error('Error deleting portfolio item:', error);
		res.status(500).json({ message: 'Internal server error' });
	}
};

// GET /provider/profile/skills/catalog?category=<slug|id|name>: kept for compatibility; delegates to the same function as GET /api/skills/catalog.
export const getSkillsCatalog = async (req: Request, res: Response) => {
	try {
		res.json({ success: true, data: await getCatalogForCategoryParam(prisma, req.query.category) });
	} catch (error) {
		res.status(500).json({ success: false, message: 'Internal server error' });
	}
};

// PUT /provider/profile/whatsapp { alternativePhone }: a direct save (no code, no request, no review). The e-mail and the primary phone stay immutable.
export const updatePreferences = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });
		const parsed = updateProviderPreferencesSchema.safeParse(req.body);
		if (!parsed.success) return res.status(400).json({ success: false, message: parsed.error.issues.map(i => i.message).join(', ') });
		const data = await providerProfileService.updatePreferences(userId, parsed.data);
		res.json({ success: true, message: 'تم حفظ التفضيلات', data });
	} catch (error: any) {
		if (error?.message === 'PROFILE_NOT_FOUND') return res.status(404).json({ success: false, message: 'ملف مقدم الخدمة غير موجود' });
		res.status(500).json({ success: false, message: 'Internal server error' });
	}
};

export const updateWhatsapp = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });
		const result = await providerProfileService.updateWhatsapp(userId, req.body?.alternativePhone);
		res.json({ success: true, message: result.alternativePhone ? 'تم حفظ رقم WhatsApp' : 'تم حذف رقم WhatsApp', data: result });
	} catch (error: any) {
		if (error?.message === 'INVALID_WHATSAPP') return res.status(400).json({ success: false, code: 'INVALID_WHATSAPP', message: 'رقم WhatsApp غير صالح: من 8 إلى 15 رقمًا، ويمكن أن يبدأ بـ +' });
		res.status(500).json({ success: false, message: 'Internal server error' });
	}
};
