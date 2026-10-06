import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import { parsePaypalPayoutEmail } from '../dtos/profile.dto';
import { logger } from '../config/logger';
import { computeClientCompletion, computeClientMissingItems } from '../utils/completion-calculators';
import { clientProfileService } from '../services/client-profile.service';
import { AppError } from '../utils/app-error';

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

      const [profile, user] = await Promise.all([
        prisma.clientProfile.findUnique({ where: { userId } }),
        prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, avatarUrl: true, accountType: true, idNumber: true } })
      ]);

      // The wizard also needs to know how complete the profile is and what is missing (same rules as /profiles/me).
      const input = { user: user || {}, clientProfile: profile || {} };
      const completionPercentage = computeClientCompletion(input);
      const missingItems = computeClientMissingItems(input);
      if (profile && profile.completionPercentage !== completionPercentage) {
        try {
          await prisma.clientProfile.update({ where: { userId }, data: { completionPercentage }, select: { id: true } });
        } catch (error) {
          logger.error(`[ClientProfileController] Failed to sync stored client completion (userId=${userId})`, error);
        }
      }

      res.status(200).json({
        success: true,
        data: { ...(profile || {}), completionPercentage, missingItems }
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
        // isNafathVerified / kycStatus / isVerified are NEVER written from this request: they are read-only here and change only
        // through a real verification integration or the admin KYC decision (onboarding.service). See the guarded update below.

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
      // submitting the wizard marks an UNVERIFIED/REJECTED profile as PENDING review; a VERIFIED one is never downgraded
      await prisma.clientProfile.updateMany({ where: { userId, kycStatus: { in: ['UNVERIFIED', 'REJECTED'] } }, data: { kycStatus: 'PENDING' } });
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
  // DISABLED (AUD-FND-000024): there is no Nafath integration, and this endpoint used to set isNafathVerified=true for anyone who called
  // it. It now answers honestly and writes nothing. The route stays so the feature is not deleted; it is re-enabled only together with a
  // real Nafath verification.
  public async nafathVerify(_req: Request, _res: Response, next: NextFunction) {
    next(Object.assign(new AppError('التحقق عبر نفاذ غير متاح حاليًا', 503), { code: 'NAFATH_UNAVAILABLE' }));
  }
}

export const clientProfileController = new ClientProfileController();
