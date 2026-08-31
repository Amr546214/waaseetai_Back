import { prisma } from '../config/db';
import { ChangeRequestStatus, SensitiveFieldType } from '@prisma/client';

export class ProfileRequestsService {
	public async getRequests(userId: string) {
		const profile = await prisma.affiliateProfile.findUnique({ where: { userId } });
		if (!profile) throw new Error('Affiliate profile not found');

		const requests = await prisma.profileChangeRequest.findMany({
			where: { affiliateProfileId: profile.id },
			orderBy: { createdAt: 'desc' },
		});

		const pendingAiCount = requests.filter(r => r.status === ChangeRequestStatus.PENDING_AI_REVIEW).length;
		const pendingHumanCount = requests.filter(r => r.status === ChangeRequestStatus.PENDING_HUMAN_APPROVAL).length;
		const approvedCount = requests.filter(r => r.status === ChangeRequestStatus.APPROVED_AND_APPLIED).length;
		const rejectedCount = requests.filter(r => r.status === ChangeRequestStatus.REJECTED).length;

		return {
			totalRequests: requests.length,
			pendingAiCount,
			pendingHumanCount,
			approvedCount,
			rejectedCount,
			items: requests,
		};
	}

	public async withdrawRequest(userId: string, requestId: string) {
		const profile = await prisma.affiliateProfile.findUnique({ where: { userId } });
		if (!profile) throw new Error('Affiliate profile not found');

		const req = await prisma.profileChangeRequest.findUnique({
			where: { requestNumber: requestId },
		});

		if (!req) throw new Error('Request not found');
		if (req.affiliateProfileId !== profile.id) throw new Error('Unauthorized');

		if (req.status !== ChangeRequestStatus.PENDING_AI_REVIEW && req.status !== ChangeRequestStatus.PENDING_HUMAN_APPROVAL) {
			throw new Error('Can only withdraw pending requests');
		}

		const updated = await prisma.profileChangeRequest.update({
			where: { requestNumber: requestId },
			data: { status: ChangeRequestStatus.WITHDRAWN },
		});

		return updated;
	}
}

export const profileRequestsService = new ProfileRequestsService();
