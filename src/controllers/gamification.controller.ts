import { Request, Response } from 'express';
import { gamificationService } from '../services/gamification.service';
import { prisma } from '../config/db';

class GamificationController {
  async getLevelDetails(req: Request, res: Response) {
    try {
      const providerId = (req as any).user?.id; // Assumes provider JWT gives user ID
      if (!providerId) {
        // Fallback for development if no JWT is passed
        const testUser = await prisma.user.findFirst({ where: { accountType: 'PROVIDER_INDIVIDUAL' } });
        if (testUser) {
          (req as any).user = { id: testUser.id };
        } else {
          return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
      }

      const details = await gamificationService.getLevelDetails((req as any).user.id);
      res.json({ success: true, data: details });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const gamificationController = new GamificationController();
