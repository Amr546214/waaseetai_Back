import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { storeKycFileIfNeeded } from '../utils/cloudinary-storage';
import { assertKycFileValues } from '../utils/kyc-value-guard';
import { parsePaypalPayoutEmail } from '../dtos/profile.dto';
import { logger } from '../config/logger';
import { computeClientCompletion, computeClientMissingItems } from '../utils/completion-calculators';
import { clientProfileService } from '../services/client-profile.service';
import { AppError } from '../utils/app-error';
import { onboardingService } from '../services/onboarding.service';
import { nonPaypalPayoutKeys, PAYPAL_ONLY_MESSAGE, withoutLegacyPayoutFields } from '../utils/client-payout-fields';
import { normalizeClientSetupBody, isClientSetupComplete } from '../utils/client-setup-payload';
import { clientSetupSchema, clientSetupStepSchemas, ClientSetupStep } from '../dtos/client-profile-setup.dto';
import { assertVerifiedIdentityUnchanged, identitySubmissionChanged } from '../utils/kyc-identity-guard';

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
        data: { ...(withoutLegacyPayoutFields(profile) || {}), completionPercentage, missingItems }
      });
    } catch (error) {
      next(error);
    }
  }

  // B) POST /api/client/profile/setup
  public async saveSetupData(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      // Full validation first: types, length limits, a missing object or a non-true agreement is a 400 (never a TypeError/500).
      // Known alternative names are mapped onto the canonical fields; an unknown field is a 400 (never accepted and silently dropped).
      const normalized = normalizeClientSetupBody(req.body);
      if (!normalized.ok) return res.status(400).json({ success: false, message: 'بعض الحقول غير مدعومة ولم يُحفظ شيء', errors: normalized.errors });
      const parsed = clientSetupSchema.safeParse(normalized.body);
      if (!parsed.success) {
        const errors = parsed.error.issues.map(issue => {
          const field = issue.path.join('.');
          return { path: field, field, message: issue.message, code: issue.code };
        });
        return res.status(400).json({ success: false, message: 'بيانات غير صحيحة، يرجى مراجعة الحقول المحددة', errors });
      }
      const payload = parsed.data;

      // Extract specific group payloads
      const { details, identity, documents, agreements } = payload;
      const bank: any = payload.bank ?? {};

      // A VERIFIED account's identity (idNumber / dob) is frozen.
      const stored = await prisma.clientProfile.findUnique({ where: { userId }, select: { idNumber: true, dob: true, kycStatus: true } });
      assertVerifiedIdentityUnchanged(stored, details);
      
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

      assertKycFileValues([identity.frontId, identity.backId, documents.supportingDocs], userId);
      const [frontIdUrl, backIdUrl, supportingDocsUrl] = await Promise.all([
        storeKycFileIfNeeded(identity.frontId, `waseetai/clients/${userId}/identity`, 'front-id'),
        storeKycFileIfNeeded(identity.backId, `waseetai/clients/${userId}/identity`, 'back-id'),
        storeKycFileIfNeeded(documents.supportingDocs, `waseetai/clients/${userId}/documents`, 'supporting-document')
      ]);

      const clientData = {
        userId,
        // '' / null = not provided: a stored idNumber / dob is kept (a VERIFIED identity is never erased by a re-save)
        idNumber: details.idNumber || undefined,
        dob: details.dob ? new Date(details.dob) : undefined, // absent = keep the stored value (a re-save never erases it)
        country: details.country,
        city: details.city,
        industry: details.occupation,
        address: details.address,
        bio: details.bio,
        ...(Array.isArray(details.interests) ? { interests: details.interests } : {}),
        
        // Empty/absent = "keep what is stored": the client can no longer see a stored private document, so a re-save must not wipe it.
        frontIdUrl: frontIdUrl || undefined,
        backIdUrl: backIdUrl || undefined,
        // isNafathVerified / kycStatus / isVerified are NEVER written from this request: they are read-only here and change only
        // through a real verification integration or the admin KYC decision (onboarding.service). See the guarded update below.

        // PayPal path leaves bank columns untouched (undefined = not written).
        // PayPal is the only financial method: only the PayPal email is ever written (the legacy bank columns are never touched).
        ...(isPaypal ? { paymentType: 'paypal', paypalPayoutEmail } : {}),

        supportingDocsUrl: supportingDocsUrl || undefined,
        notes: documents.notes,

        accurateAgreed: agreements.accurate,
        termsAgreed: agreements.terms,
        privacyAgreed: agreements.privacy,

        // isProfileComplete is decided below from what was really stored, not assumed from the POST
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
      // complete identity documents → a PENDING review record the admin can see (AUD-FND-000044); kycStatus follows it (never downgraded)
      await onboardingService.submitSetupDocuments(userId, { idNumber: result.idNumber, frontIdUrl: result.frontIdUrl, backIdUrl: result.backIdUrl }, { identityChanged: identitySubmissionChanged(stored, details, { front: frontIdUrl, back: backIdUrl }) });
      const completion = computeClientCompletion({ user: currentUser || {}, clientProfile: result });
      const finalResult = await prisma.clientProfile.update({
        where: { userId },
        data: { completionPercentage: completion, isProfileComplete: isClientSetupComplete(result) }
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

  // B2) PUT /api/client/profile/setup/step/:step — stores ONE wizard step as soon as the user moves on (1 details, 2 identity documents,
  // 3 PayPal, 4 optional documents). Same rules as the final POST /setup for each field (verified identity frozen, KYC file checks, PayPal
  // validation, a complete identity -> a PENDING review), but nothing about the agreements / isProfileComplete: that stays the final submit.
  public async saveSetupStep(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const step = Number(req.params.step) as ClientSetupStep;
      const schema = clientSetupStepSchemas[step];
      if (!schema) return res.status(400).json({ success: false, message: 'خطوة غير معروفة' });
      // PayPal is the only financial method: a bank / IBAN / account holder / wallet value is refused, never silently dropped.
      const forbidden = [...nonPaypalPayoutKeys(req.body), ...nonPaypalPayoutKeys((req.body as any)?.bank)];
      if (forbidden.length) {
        return res.status(400).json({ success: false, message: PAYPAL_ONLY_MESSAGE, errors: forbidden.map(k => ({ path: k, field: k, message: PAYPAL_ONLY_MESSAGE, code: 'custom' })) });
      }
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        const errors = parsed.error.issues.map(issue => {
          const field = issue.path.join('.');
          return { path: field, field, message: issue.message, code: issue.code };
        });
        return res.status(400).json({ success: false, message: 'بيانات غير صحيحة، يرجى مراجعة الحقول المحددة', errors });
      }
      const body: any = parsed.data;
      const stored = await prisma.clientProfile.findUnique({ where: { userId }, select: { idNumber: true, dob: true, kycStatus: true } });
      const data: Record<string, unknown> = {};
      let identityArgs: { details: { idNumber?: string | null; dob?: string | null }; front?: string | null; back?: string | null } | null = null;

      if (step === 1) {
        const d = body.details;
        assertVerifiedIdentityUnchanged(stored, d);
        // '' / null = not provided: a stored value is kept
        Object.assign(data, {
          idNumber: d.idNumber || undefined,
          dob: d.dob ? new Date(d.dob) : undefined,
          country: d.country || undefined,
          city: d.city || undefined,
          industry: d.occupation || undefined,
          address: d.address || undefined,
          bio: d.bio || undefined,
          ...(Array.isArray(d.interests) ? { interests: d.interests } : {})
        });
        identityArgs = { details: d };
      } else if (step === 2) {
        const { frontId, backId } = body.identity;
        assertKycFileValues([frontId, backId], userId);
        const [frontIdUrl, backIdUrl] = await Promise.all([
          storeKycFileIfNeeded(frontId, `waseetai/clients/${userId}/identity`, 'front-id'),
          storeKycFileIfNeeded(backId, `waseetai/clients/${userId}/identity`, 'back-id')
        ]);
        Object.assign(data, { frontIdUrl: frontIdUrl || undefined, backIdUrl: backIdUrl || undefined });
        identityArgs = { details: {}, front: frontIdUrl, back: backIdUrl };
      } else if (step === 3) {
        const paypalPayoutEmail = parsePaypalPayoutEmail(body.paypalPayoutEmail);
        if (!paypalPayoutEmail) return res.status(400).json({ success: false, message: 'بريد PayPal غير صحيح', errors: [{ path: 'paypalPayoutEmail', field: 'paypalPayoutEmail', message: 'بريد PayPal غير صحيح' }] });
        Object.assign(data, { paymentType: 'paypal', paypalPayoutEmail });
      } else {
        const { supportingDocs, notes } = body.documents;
        assertKycFileValues([supportingDocs], userId);
        const supportingDocsUrl = await storeKycFileIfNeeded(supportingDocs, `waseetai/clients/${userId}/documents`, 'supporting-document');
        Object.assign(data, { supportingDocsUrl: supportingDocsUrl || undefined, notes: notes || undefined });
      }

      const [result, currentUser] = await prisma.$transaction([
        prisma.clientProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data }),
        prisma.user.findUnique({ where: { id: userId } })
      ]);
      if (identityArgs) {
        // a complete identity (id number + both documents) -> a PENDING review record the admin can see; never re-opened by an unchanged save
        await onboardingService.submitSetupDocuments(userId, { idNumber: result.idNumber, frontIdUrl: result.frontIdUrl, backIdUrl: result.backIdUrl }, { identityChanged: identitySubmissionChanged(stored, identityArgs.details, { front: identityArgs.front, back: identityArgs.back }) });
      }
      const input = { user: currentUser || {}, clientProfile: result };
      const completionPercentage = computeClientCompletion(input);
      const finalResult = await prisma.clientProfile.update({ where: { userId }, data: { completionPercentage } });
      res.status(200).json({ success: true, message: 'تم حفظ الخطوة', data: { ...finalResult, completionPercentage, missingItems: computeClientMissingItems(input) } });
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
