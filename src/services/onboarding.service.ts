import { OnboardingStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';

export class OnboardingService {
  async saveUpload(userId: string, input: { documentType: string; documentUrl: string; documentName: string }) {
    const record = await prisma.clientOnboarding.upsert({ where: { userId }, create: { userId, documentType: input.documentType, documentUrl: input.documentUrl, documentName: input.documentName, status: OnboardingStatus.PENDING }, update: { documentType: input.documentType, documentUrl: input.documentUrl, documentName: input.documentName, status: OnboardingStatus.PENDING, rejectionReason: null, reviewedAt: null } });
    await prisma.user.update({ where: { id: userId }, data: { idDocumentUrl: input.documentUrl } });
    return record;
  }

  async getStatus(userId: string) {
    const record = await prisma.clientOnboarding.findUnique({ where: { userId } });
    return record || { userId, status: OnboardingStatus.PENDING, documentUrl: null, documentName: null, documentType: null, rejectionReason: null, reviewedAt: null };
  }
}

export const onboardingService = new OnboardingService();
