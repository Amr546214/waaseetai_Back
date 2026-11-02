import { Request, Response } from 'express';
import { feePolicyService } from '../services/fee-policy.service';
import { gamificationService, getClientLevelDetails } from '../services/gamification.service';
import { publicLevelsPayload } from '../config/levels.config';

class GamificationController {
  async getLevelDetails(req: Request, res: Response) {
    try {
      const providerId = (req as any).user?.id; // Assumes provider JWT gives user ID
      if (!providerId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const details = await gamificationService.getLevelDetails((req as any).user.id);
      res.json({ success: true, data: details });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

class ClientLevelController {
  async getClientLevelDetails(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id ?? (req as any).user?.userId;
      if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
      res.json({ success: true, data: await getClientLevelDetails(userId) });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

/** GET /api/levels — the single, public, read-only level table (names, thresholds, percentages, colours) for every page that shows levels. */
export const getLevelsTable = async (_req: Request, res: Response) => {
  try {
    const policy = await feePolicyService.active();
    const base = publicLevelsPayload();
    // the percentages shown come from the fee policy IN FORCE now (the same values new contracts / deposits / payouts use); names, thresholds and colours stay in code
    const roles = base.roles as Record<string, { levels: Array<{ level: number; percent: number }> }>;
    const tables: Record<string, readonly number[]> = { PROVIDER: policy.payload.providerCommissionByLevel, CLIENT: policy.payload.clientCashbackByLevel, MARKETER: policy.payload.marketerCommissionByLevel };
    for (const role of Object.keys(roles)) roles[role].levels = roles[role].levels.map(l => ({ ...l, percent: tables[role][l.level - 1] ?? l.percent }));
    res.json({
      success: true,
      data: {
        ...base,
        feePolicy: { version: policy.version, effectiveFrom: policy.effectiveFrom },
        // the payment-percentage tables: the provider's final deduction IS the PROVIDER commission above (no extra fee on top)
        payments: { clientDeposit: { ...policy.payload.depositFeePercent }, marketerWithdrawal: { ...policy.payload.marketerWithdrawalFeePercent }, minMarketerPayout: policy.payload.minMarketerPayout, minProviderPayout: policy.payload.minProviderPayout },
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const gamificationController = new GamificationController();
export const clientLevelController = new ClientLevelController();
