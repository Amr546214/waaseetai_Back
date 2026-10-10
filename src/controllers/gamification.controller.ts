import { Request, Response } from 'express';
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
export const getLevelsTable = (_req: Request, res: Response) => { res.json({ success: true, data: publicLevelsPayload() }); };

export const gamificationController = new GamificationController();
export const clientLevelController = new ClientLevelController();
