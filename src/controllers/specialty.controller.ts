import { Request, Response } from 'express';
import { uploadMulterFile } from '../utils/cloudinary-storage';
import { specialtyService } from '../services/specialty.service';
import { prisma } from '../config/db';

class SpecialtyController {
  async getCategories(req: Request, res: Response) {
    try {
      const categories = await specialtyService.getCategories();
      res.json({ success: true, data: categories });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getPublicSpecialties(req: Request, res: Response) {
    try {
      const categoryId = req.query.categoryId as string | undefined;
      const specialties = await specialtyService.getPublicSpecialties(categoryId);
      res.json({ success: true, data: specialties });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async selectSpecialty(req: Request, res: Response) {
    try {
      const providerId = (req as any).user.id;
      
      const profile = await prisma.providerProfile.findUnique({
        where: { userId: providerId }
      });
      if (!profile) throw new Error('Provider profile not found');

      const { specialtyId, subSpecialties, isCustom, customName } = req.body;
      const result = await specialtyService.selectSpecialty(profile.id, specialtyId, subSpecialties, isCustom, customName);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async uploadSamples(req: Request, res: Response) {
    try {
      const { providerSpecialtyId, sampleCount } = req.body;
      const files = req.files as Express.Multer.File[] || [];
      
      const samplesData = [];
      const count = parseInt(sampleCount || '0', 10);
      
      for (let i = 0; i < count; i++) {
        const title = req.body[`sampleTitle_${i}`] || 'نموذج عمل';
        
        // Find the public sample file for this block
        const publicFile = files.find(f => f.fieldname === `publicSample_${i}`);
        
        // Find the proof files for this block
        const proofFiles = files.filter(f => f.fieldname === `proofFiles_${i}`);
        
        const publicUpload = publicFile ? await uploadMulterFile(publicFile, `waseetai/specialties/${providerSpecialtyId}/samples`) : null;
        const privateUpload = proofFiles[0] ? await uploadMulterFile(proofFiles[0], `waseetai/specialties/${providerSpecialtyId}/proofs`) : null;
        samplesData.push({
          title,
          publicSampleUrl: publicUpload?.url || '',
          privateProofUrl: privateUpload?.url || null
        });
      }

      const result = await specialtyService.uploadWorkSamples(providerSpecialtyId, samplesData);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async audit(req: Request, res: Response) {
    try {
      const { providerSpecialtyId } = req.body;
      const result = await specialtyService.executeAiAudit(providerSpecialtyId);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getTest(req: Request, res: Response) {
    try {
      const { specialtyId } = req.params;
      const result = await specialtyService.getSpecialtyTest(specialtyId as string);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async submitTest(req: Request, res: Response) {
    try {
      const { providerSpecialtyId, testId, answers } = req.body;
      const result = await specialtyService.submitTest(providerSpecialtyId, testId, answers);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const specialtyController = new SpecialtyController();
