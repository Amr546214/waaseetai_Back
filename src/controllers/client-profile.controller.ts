import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';

export class ClientProfileController {
  
  // A) GET /api/client/profile/setup
  public async getSetupData(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;

      const profile = await prisma.clientProfile.findUnique({
        where: { userId }
      });

      res.status(200).json({
        success: true,
        data: profile || {}
      });
    } catch (error) {
      next(error);
    }
  }

  // B) POST /api/client/profile/setup
  public async saveSetupData(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const payload = req.body;

      // Extract specific group payloads
      const { details, identity, bank, documents, agreements } = payload;

      // Basic server-side validations
      if (details.idNumber && !/^[12]\d{9}$/.test(details.idNumber)) {
        return res.status(400).json({ success: false, message: 'Invalid ID Number format.' });
      }
      
      if (bank.iban && bank.iban.length !== 24) {
        return res.status(400).json({ success: false, message: 'IBAN must be exactly 24 characters.' });
      }

      const [frontIdUrl, backIdUrl, supportingDocsUrl] = await Promise.all([
        storeDataUriIfNeeded(identity.frontId, `waseetai/clients/${userId}/identity`, 'front-id'),
        storeDataUriIfNeeded(identity.backId, `waseetai/clients/${userId}/identity`, 'back-id'),
        storeDataUriIfNeeded(documents.supportingDocs, `waseetai/clients/${userId}/documents`, 'supporting-document')
      ]);

      const clientData = {
        userId,
        idNumber: details.idNumber,
        dob: details.dob ? new Date(details.dob) : null,
        country: details.country,
        city: details.city,
        industry: details.occupation,
        address: details.address,
        
        frontIdUrl,
        backIdUrl,
        kycStatus: 'PENDING' as any,

        paymentType: bank.paymentType,
        bankName: bank.bankName,
        accountHolder: bank.accountHolder,
        iban: bank.iban,

        supportingDocsUrl,
        notes: documents.notes,

        accurateAgreed: agreements.accurate,
        termsAgreed: agreements.terms,
        privacyAgreed: agreements.privacy,

        isProfileComplete: true
      };

      const result = await prisma.clientProfile.upsert({
        where: { userId },
        create: clientData,
        update: clientData
      });

      res.status(200).json({
        success: true,
        message: 'تم حفظ البيانات بنجاح',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  // C) POST /api/client/profile/nafath-verify
  public async nafathVerify(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;

      // Simulated NAFATH Verification logic here

      await prisma.clientProfile.upsert({
        where: { userId },
        create: {
          userId,
          isNafathVerified: true,
          kycStatus: 'PENDING' // Update depending on flow
        },
        update: {
          isNafathVerified: true
        }
      });

      res.status(200).json({
        success: true,
        message: 'تم التحقق بنجاح عبر بوابة نفاذ الوطنية'
      });
    } catch (error) {
      next(error);
    }
  }
}

export const clientProfileController = new ClientProfileController();
