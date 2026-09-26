import { prisma } from '../config/db';

// Implementation Batch 7 — replaces team-deliveries.ts's fully hardcoded
// "company deliveries" list (7 fictional stage deliveries with fabricated
// aiMatchPct values 94/97/91/99/96/97/94 attributed to 3 made-up team
// members). There is no team-member/company-employee model anywhere in the
// Prisma schema — a provider account (individual or company) is a single
// user, so a real per-employee delivery breakdown cannot be built without a
// schema change (out of scope for this batch; flagged separately). This
// service returns the provider's OWN real StageDelivery rows instead —
// genuine project/stage/status/date/contract/file data, with no fabricated
// AI match score and no invented team-member attribution.
export interface CompanyDeliveryItem {
  id: string;
  projectTitle: string;
  phaseLabel: string;
  status: 'SUBMITTED' | 'REVISION_REQUESTED' | 'APPROVED';
  statusLabel: string;
  submittedAt: Date;
  contractRef: string;
  amountLabel: string;
  files: string[];
  note: string;
}

const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: 'بانتظار رد العميل',
  REVISION_REQUESTED: 'بانتظار تعديل',
  APPROVED: 'مكتمل ومُفرَج'
};

class ProviderDeliveriesService {
  async getCompanyDeliveries(providerId: string): Promise<CompanyDeliveryItem[]> {
    const deliveries = await prisma.stageDelivery.findMany({
      where: { providerId },
      orderBy: { submittedAt: 'desc' },
      take: 50,
      include: {
        stage: {
          include: {
            contract: {
              include: {
                project: { select: { title: true } }
              }
            }
          }
        }
      }
    });

    return deliveries.map((delivery) => {
      const stage = delivery.stage;
      const contract = stage.contract;
      return {
        id: delivery.id,
        projectTitle: contract.project.title,
        phaseLabel: `${stage.title} · المرحلة ${stage.stepOrder} من ${contract.phasesCount}`,
        status: delivery.status,
        statusLabel: STATUS_LABELS[delivery.status] || delivery.status,
        submittedAt: delivery.submittedAt,
        contractRef: `CT-${contract.id.substring(0, 6).toUpperCase()}`,
        amountLabel: `${stage.amount.toLocaleString('en-US')} ريال`,
        files: delivery.files,
        note: delivery.note
      };
    });
  }
}

export const providerDeliveriesService = new ProviderDeliveriesService();
