import { prisma } from '../config/db';

export class NewsletterService {
  async subscribe(email: string, source?: string) {
    const normalizedEmail = email.trim().toLowerCase();
    return prisma.newsletterSubscriber.upsert({
      where: { email: normalizedEmail },
      update: { unsubscribedAt: null, ...(source ? { source } : {}) },
      create: { email: normalizedEmail, source: source || null },
    });
  }

  async unsubscribe(email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    await prisma.newsletterSubscriber.updateMany({
      where: { email: normalizedEmail },
      data: { unsubscribedAt: new Date() },
    });
    return { email: normalizedEmail };
  }
}

export const newsletterService = new NewsletterService();
