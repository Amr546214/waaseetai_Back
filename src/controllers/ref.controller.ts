import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';

export class RefController {
  public async handleReferralClick(req: Request, res: Response, next: NextFunction) {
    try {
      const slug = req.params.slug as string;
      const utm_source = req.query.utm_source as string;

      // Explicit select — only `id` is used below (channel-metric upsert +
      // existence check). Deployment-safety: AffiliateProfile.level exists in
      // the Prisma schema but its migration has not been applied to DEV/LIVE
      // yet, so default/full selection here would 500 this public, unauth
      // referral-click endpoint. See src/utils/affiliate-profile-safe-select.util.ts.
      const affiliate = await prisma.affiliateProfile.findUnique({
        where: { referralSlug: slug },
        select: { id: true },
      });

      if (affiliate) {
        // Increment click logs in background
        if (utm_source) {
          // find channel by utm_source matching enum or fallback to OTHER
          const channelName = utm_source.toUpperCase();
          const channelMap: any = {
            'TIKTOK': 'TIKTOK',
            'X_TWITTER': 'X_TWITTER',
            'TWITTER': 'X_TWITTER',
            'INSTAGRAM': 'INSTAGRAM',
            'LINKEDIN': 'LINKEDIN',
          };
          const mappedChannel = channelMap[channelName] || 'OTHER';

          prisma.affiliateChannelMetric.upsert({
            where: {
              affiliateId_channel: {
                affiliateId: affiliate.id,
                channel: mappedChannel,
              },
            },
            update: {
              visitors: { increment: 1 },
            },
            create: {
              affiliateId: affiliate.id,
              channel: mappedChannel,
              visitors: 1,
            },
          }).catch(err => console.error("Error updating channel metric:", err));
        }

        // Set secure HTTP-Only attribution cookie for 30 days
        res.cookie('waseet_ref_code', slug, {
          maxAge: 30 * 24 * 60 * 60 * 1000,
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
        });
      }

      // Redirect visitor seamlessly to the registration page — this MUST
      // match the Angular router's actual registration path exactly.
      // /register does not exist at the app's root; the register component
      // is mounted at /auth/register (nested under the 'auth' layout route
      // in app.routes.ts). A bare /register previously landed real referral
      // clicks on the frontend's 404 page.
      res.redirect(302, '/auth/register');
    } catch (error) {
      next(error);
    }
  }
}

export const refController = new RefController();
