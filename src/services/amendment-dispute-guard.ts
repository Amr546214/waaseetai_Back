import { DisputeStatus } from '@prisma/client';
import { prisma } from '../config/db';

// Isolated on purpose (one tiny file) so the dispute-freeze work can replace its body without touching the amendment code.
// An amendment may not become effective while a dispute is OPEN / UNDER_REVIEW on the project.
type DisputeReader = { dispute: { findFirst: (args: any) => Promise<{ id: string } | null> } };

export async function hasActiveDispute(projectId: string, db: DisputeReader = prisma as unknown as DisputeReader): Promise<boolean> {
	const found = await db.dispute.findFirst({
		where: { projectId, status: { in: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW] } },
		select: { id: true }
	});
	return !!found;
}
