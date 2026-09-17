import { Request, Response } from 'express';
import { providerProfileService } from '../services/provider-profile.service';
import { prisma } from '../config/db';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { sessionService } from '../services/session.service';
import { computeProviderCompletion } from '../utils/completion-calculators';

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

export const changePassword = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const { currentPassword, newPassword } = req.body || {};
		const data = await providerProfileService.changePassword(userId, String(currentPassword || ''), String(newPassword || ''), auditContext(req));
		res.json({ success: true, data });
	} catch (error: any) {
		const status = error.message === 'CURRENT_PASSWORD_INCORRECT' ? 401 : 400;
		res.status(status).json({ success: false, message: error.message });
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

export const getSetupData = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });

		const profile = await prisma.providerProfile.findUnique({
			where: { userId }
		});

		res.status(200).json({ success: true, data: profile || {} });
	} catch (error) {
		res.status(500).json({ message: 'Internal server error' });
	}
};

export const saveSetupData = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });

		const payload = req.body;
		const { details, identity, bank, documents, agreements, specialties, portfolio } = payload;
		const [frontIdUrl, backIdUrl, supportingDocsUrl] = await Promise.all([
			storeDataUriIfNeeded(identity?.frontId, `waseetai/providers/${userId}/identity`, 'front-id'),
			storeDataUriIfNeeded(identity?.backId, `waseetai/providers/${userId}/identity`, 'back-id'),
			storeDataUriIfNeeded(documents?.supportingDocs, `waseetai/providers/${userId}/documents`, 'supporting-document')
		]);
		const certUrls = await Promise.all((identity?.certs || []).map((url: string, index: number) =>
			storeDataUriIfNeeded(url, `waseetai/providers/${userId}/certificates`, `certificate-${index + 1}`)
		));

		const providerData = {
			userId,
			idNumber: details?.idNumber,
			dob: details?.dob ? new Date(details.dob) : null,
			country: details?.country,
			city: details?.city,
			industry: details?.occupation,
			address: details?.address,
			bio: details?.bio,
			languages: details?.languages || [],
			yearsOfExperience: details?.expYears ?
				(details.expYears === 'أقل من سنة' ? 1 :
					details.expYears === '1 الى 3 سنوات' ? 2 :
						details.expYears === '3 الى 5 سنوات' ? 4 :
							details.expYears === '5 الى 10 سنوات' ? 7 :
								details.expYears === 'أكثر من 10 سنوات' ? 10 :
									parseInt(details.expYears, 10) || null) : null,

			mainSpecialty: specialties?.mainSpec,
			subSpecialties: specialties?.subSpecs || [],

			frontIdUrl,
			backIdUrl,
			certUrls: certUrls.filter(Boolean) as string[],
			isNafathVerified: identity?.isNafathVerified,
			kycStatus: 'PENDING' as any,

			paymentType: bank?.paymentType,
			bankName: bank?.bankName,
			accountHolder: bank?.accountHolder,
			iban: bank?.iban,

			supportingDocsUrl,
			notes: documents?.notes,

			accurateAgreed: agreements?.accurate,
			termsAgreed: agreements?.terms,
			privacyAgreed: agreements?.privacy,

			isProfileSetupComplete: true
		};

		const result = await prisma.providerProfile.upsert({
			where: { userId },
			create: providerData,
			update: providerData
		});

		if (portfolio) {
			await prisma.portfolioItem.deleteMany({ where: { providerProfileId: result.id } });
			const portfolioItems = [];
			for (const spec of Object.keys(portfolio)) {
				for (const item of portfolio[spec]) {
					if (item.review || (item.proofs && item.proofs.length > 0)) {
						const proofUrls = await Promise.all((item.proofs || []).map((url: string, index: number) =>
							storeDataUriIfNeeded(url, `waseetai/providers/${userId}/portfolio`, `${spec}-${index + 1}`)
						));
						portfolioItems.push({
							providerProfileId: result.id,
							title: `نموذج أعمال - ${spec}`,
							description: item.review,
							coverImage: proofUrls[0] || null,
							tags: proofUrls.filter(Boolean) as string[]
						});
					}
				}
			}
			if (portfolioItems.length > 0) {
				await prisma.portfolioItem.createMany({ data: portfolioItems });
			}
		}

		// Phase 3D.2A: recalculate ProviderProfile.completionPercentage from the
		// FINAL state — after the upsert above AND any portfolio items just
		// created, since portfolioItems.length is a scored factor. Re-fetches
		// with the relations the formula needs (skills/portfolioItems) rather
		// than trusting `result`, which has neither (no `include` was used on
		// the upsert above). No more User.profileCompletionPercent=100
		// hardcode; `status: 'ACTIVE'` (identity/activation behavior) is
		// preserved unchanged.
		const finalProfile = await prisma.providerProfile.findUnique({
			where: { userId },
			include: { skills: true, portfolioItems: true }
		});
		const currentUser = await prisma.user.findUnique({ where: { id: userId } });
		const completion = computeProviderCompletion({ providerProfile: finalProfile || result, user: currentUser || {} });

		const [updatedResult] = await prisma.$transaction([
			prisma.providerProfile.update({ where: { userId }, data: { completionPercentage: completion } }),
			prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } })
		]);

		res.status(200).json({
			success: true,
			message: 'تم حفظ البيانات بنجاح',
			data: updatedResult
		});
	} catch (error) {
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

		const publicProfile = await providerProfileService.getPublicProfile(providerId);
		res.json({ success: true, data: publicProfile });
	} catch (error: any) {
		console.error('Error fetching public profile:', error);
		res.status(500).json({ success: false, message: error.message || 'Internal server error' });
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
		res.status(500).json({ success: false, message: error.message });
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
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const { category, changes } = req.body || {};
		const result = await providerProfileService.initiateSensitiveChange(userId, String(category || ''), changes || {}, auditContext(req));
		res.status(201).json({ success: true, data: result });
	} catch (error: any) {
		const status = error.message === 'EMAIL_ALREADY_USED' ? 409 : 400;
		res.status(status).json({ success: false, message: error.message });
	}
};

export const verifySensitiveChange = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
		const { requestId, code } = req.body || {};
		if (!requestId || !/^\d{6}$/.test(String(code || ''))) {
			return res.status(400).json({ success: false, message: 'A valid requestId and six-digit OTP are required' });
		}
		const result = await providerProfileService.verifySensitiveChange(userId, String(requestId), String(code), auditContext(req));
		res.json({ success: true, data: result });
	} catch (error: any) {
		res.status(400).json({ success: false, message: error.message });
	}
};

export const reviewSensitiveChange = async (req: Request, res: Response) => {
	try {
		const { approved, rejectionReason } = req.body || {};
		if (typeof approved !== 'boolean') return res.status(400).json({ success: false, message: 'approved must be boolean' });
		const result = await providerProfileService.reviewSensitiveChange(req.params.id as string, approved, rejectionReason, { ...auditContext(req), actorLabel: req.user?.email });
		res.json({ success: true, data: result });
	} catch (error: any) {
		res.status(400).json({ success: false, message: error.message });
	}
};

export const getPendingSensitiveReviews = async (_req: Request, res: Response) => {
	const data = await providerProfileService.getPendingSensitiveReviews();
	res.json({ success: true, data: data.map(item => ({ ...item, metadata: undefined })) });
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
	} catch (error) {
		res.status(500).json({ message: 'Error updating contact info', error });
	}
};

export const updateBankingInfo = async (req: Request, res: Response) => {
	try {
		const userId = req.user?.id;
		if (!userId) return res.status(401).json({ message: 'Unauthorized' });
		const profile = await providerProfileService.updateBankingInfo(userId, req.body);
		res.json(profile);
	} catch (error) {
		res.status(500).json({ message: 'Error updating banking info', error });
	}
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

		const updated = await providerProfileService.updateSkills(userId, req.body.skills || []);
		res.json(updated);
	} catch (error) {
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
		console.error('Error deleting portfolio item:', error);
		res.status(500).json({ message: 'Internal server error' });
	}
};
