import { DisputeStatus, Prisma } from '@prisma/client';

/** Shared definition for the admin dashboard alert and the follow-up queue. */
export function followUpDisputesWhere(now = new Date()): Prisma.DisputeWhereInput {
  return {
    status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] },
    createdAt: { lt: new Date(now.getTime() - 7 * 86_400_000) },
  };
}
