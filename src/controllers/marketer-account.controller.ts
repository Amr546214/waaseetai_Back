import { Request, Response, NextFunction } from 'express';
import { WithdrawalStatus } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { marketerWalletService } from '../services/marketer-wallet.service';
import { marketerSettingsService } from '../services/marketer-settings.service';
import { marketerAssetsService } from '../services/marketer-assets.service';
import { withdrawalService } from '../services/withdrawal.service';
import { updateMarketerSettingsSchema } from '../dtos/marketer-settings.dto';
import { readAffiliatePaypalEmail } from '../utils/affiliate-payout';

const userId = (req: Request) => req.user!.userId || req.user!.id;

export async function getMarketerWallet(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await marketerWalletService.getWallet(userId(req)) }); } catch (error) { next(error); }
}

/** One of the marketer's own withdrawals (every state, rejection reason included). Someone else's id answers exactly like a missing one. */
export async function getMyMarketerWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    const row = await prisma.withdrawal.findUnique({ where: { id: String(req.params.id) } });
    if (!row || row.userId !== userId(req)) throw new AppError('طلب السحب غير موجود', 404);
    const { iban: _i, accountName: _n, accountNumber: _a, ...safe } = row;
    res.json({ success: true, data: safe });
  } catch (error) { next(error); }
}

export async function getMarketerAssets(_req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await marketerAssetsService.listForMarketer() }); } catch (error) { next(error); }
}

export async function getMarketerSettings(req: Request, res: Response, next: NextFunction) {
  try { res.json({ success: true, data: await marketerSettingsService.get(userId(req)) }); } catch (error) { next(error); }
}

export async function updateMarketerSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = updateMarketerSettingsSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues.map(i => i.message).join(', '), 400);
    res.json({ success: true, message: 'تم حفظ الإعدادات', data: await marketerSettingsService.update(userId(req), parsed.data) });
  } catch (error) { next(error); }
}

/** The marketer's own data as a JSON file: profile, channels, referrals, commissions, withdrawals and settings. Never another user's data and never the identity document. */
export async function exportMarketerData(req: Request, res: Response, next: NextFunction) {
  try {
    const id = userId(req);
    const affiliate = await prisma.affiliateProfile.findUnique({
      where: { userId: id },
      select: {
        id: true, referralSlug: true, bio: true, createdAt: true,
        marketingChannels: { select: { platform: true, handle: true } },
        referrals: { select: { id: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
        commissionLogs: { select: { id: true, type: true, amount: true, currency: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
      }
    });
    if (!affiliate) throw new AppError('ملف الوسيط التسويقي غير موجود', 404);
    const [user, withdrawals, settings, paypalEmail] = await Promise.all([
      prisma.user.findUnique({ where: { id }, select: { firstName: true, lastName: true, email: true } }),
      withdrawalService.listForMarketer(id, undefined as WithdrawalStatus | undefined, 1, 100),
      marketerSettingsService.get(id),
      readAffiliatePaypalEmail(id, prisma)
    ]);
    const { id: _affiliateId, ...profile } = affiliate;
    const payload = { exportedAt: new Date().toISOString(), account: user, paypalEmail, profile, withdrawals: withdrawals.items, settings };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="waseet-marketer-data.json"');
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) { next(error); }
}
