import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { parsePaypalPayoutEmail } from '../dtos/profile.dto';
import { computeClientCompletion } from '../utils/completion-calculators';
import { clientProfileService } from '../services/client-profile.service';

export class ClientProfileController {

  // Public, unauthenticated — GET /api/client/profile/public/:id. Advisory-
  // free, real-data-only profile (see client-profile.service.ts). Same
  // shape of handler as marketer-profile.controller.ts's getPublicProfile.
  public async getPublicProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id || '');
      if (!id) {
        return res.status(400).json({ success: false, message: 'معرف غير صالح' });
      }
      const profile = await clientProfileService.getPublicProfile(id);
      res.status(200).json({ success: true, data: profile });
    } catch (error) {
      next(error);
    }
  }

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
      const { details, identity, documents, agreements } = payload;
      const bank = payload.bank ?? {};

      // Basic server-side validations
      if (details.idNumber && !/^[12]\d{9}$/.test(details.idNumber)) {
        return res.status(400).json({ success: false, message: 'Invalid ID Number format.' });
      }
      
      // PayPal payout (PayPal-only platform): optional in setup for backward
      // compatibility, but when the client chooses PayPal (paymentType='paypal')
      // or sends an email it must be a valid address. Bank fields are not
      // required/validated on this path and PayPal is never mapped into them.
      const rawPaypal = bank.paypalPayoutEmail ?? payload.paypalPayoutEmail;
      const isPaypal = bank.paymentType === 'paypal' || (rawPaypal !== undefined && rawPaypal !== null && rawPaypal !== '');
      let paypalPayoutEmail: string | null = null;
      if (isPaypal) {
        paypalPayoutEmail = parsePaypalPayoutEmail(rawPaypal);
        if (!paypalPayoutEmail) {
          return res.status(400).json({ success: false, message: 'بريد PayPal غير صحيح' });
        }
      }

      if (!isPaypal && bank.iban && bank.iban.length !== 24) {
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

        // PayPal path leaves bank columns untouched (undefined = not written).
        ...(isPaypal
          ? { paymentType: 'paypal', paypalPayoutEmail }
          : { paymentType: bank.paymentType, bankName: bank.bankName, accountHolder: bank.accountHolder, iban: bank.iban }),

        supportingDocsUrl,
        notes: documents.notes,

        accurateAgreed: agreements.accurate,
        termsAgreed: agreements.terms,
        privacyAgreed: agreements.privacy,

        isProfileComplete: true
      };

      // Phase 3D.2A: recalculate ClientProfile.completionPercentage from the
      // FINAL state (this upsert's own return value, plus the current User
      // row) after this mutation — the historical CLIENT formula, unchanged.
      // isProfileComplete (set above, in clientData) is a separate existing
      // boolean, left exactly as it was. Never writes User.profileCompletionPercent.
      const [result, currentUser] = await prisma.$transaction([
        prisma.clientProfile.upsert({
          where: { userId },
          create: clientData,
          update: clientData
        }),
        prisma.user.findUnique({ where: { id: userId } })
      ]);
      const completion = computeClientCompletion({ user: currentUser || {}, clientProfile: result });
      const finalResult = await prisma.clientProfile.update({
        where: { userId },
        data: { completionPercentage: completion }
      });

      res.status(200).json({
        success: true,
        message: 'تم حفظ البيانات بنجاح',
        data: finalResult
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
