import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { REFERRAL_COOKIE_NAME, REFERRAL_SOURCE_COOKIE_NAME, referralCookieSetOptions } from '../utils/referral-cookie';

// Link-preview / crawler / scripted clients: never counted as a visit.
const BOT_USER_AGENT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|curl|wget|python-requests|postman|node-fetch|axios/i;

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookie value: ignored */ }
  }
  return out;
}

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
        // Click tracking: every real human click on the marketer's link counts as one visit (a link without utm_source is a
        // direct visit, counted under OTHER). Bot-safe / dedupe-as-far-as-the-schema-allows: link-preview crawlers and HEAD
        // requests are not counted, and a browser that already carries this same slug+channel cookie (a refresh or a repeat
        // click within the 30-day attribution window) is not counted again. There is no per-visitor table, so this is the
        // strongest dedupe available without a migration.
        const channelMap: Record<string, string> = {
          TIKTOK: 'TIKTOK',
          X_TWITTER: 'X_TWITTER',
          TWITTER: 'X_TWITTER',
          INSTAGRAM: 'INSTAGRAM',
          LINKEDIN: 'LINKEDIN',
        };
        const mappedChannel = (utm_source && channelMap[String(utm_source).toUpperCase()]) || 'OTHER';

        const cookies = parseCookieHeader(req.headers?.cookie);
        const alreadyCounted = cookies[REFERRAL_COOKIE_NAME] === slug && cookies[REFERRAL_SOURCE_COOKIE_NAME] === mappedChannel;
        const userAgent = String(req.headers?.['user-agent'] ?? '');
        const isBot = req.method === 'HEAD' || !userAgent || BOT_USER_AGENT.test(userAgent);

        if (!alreadyCounted && !isBot) {
          prisma.affiliateChannelMetric.upsert({
            where: {
              affiliateId_channel: {
                affiliateId: affiliate.id,
                channel: mappedChannel as any,
              },
            },
            update: {
              visitors: { increment: 1 },
            },
            create: {
              affiliateId: affiliate.id,
              channel: mappedChannel as any,
              visitors: 1,
            },
          }).catch(err => console.error("Error updating channel metric:", err));
        }

        // Set secure HTTP-Only attribution cookies for 30 days (slug + the channel it came through)
        res.cookie(REFERRAL_COOKIE_NAME, slug, referralCookieSetOptions());
        res.cookie(REFERRAL_SOURCE_COOKIE_NAME, mappedChannel, referralCookieSetOptions());
      }

      // Redirect visitor seamlessly to the registration page — this MUST
      // match the Angular router's actual registration path exactly.
      // /register does not exist at the app's root; the register component
      // is mounted at /auth/register (nested under the 'auth' layout route
      // in app.routes.ts). A bare /register previously landed real referral
      // clicks on the frontend's 404 page.
      // `?ref=<slug>` carries the REAL slug to the registration page (never a placeholder like ref=1): the page resolves it to show the
      // referrer, sends it with the registration payload, and treats its presence as the "this visit came through a referral link" marker
      // (without it the page clears any older referral cookie). An unknown/expired slug sets no cookie and is reported honestly with
      // `?ref_invalid=1` (the page says so and registers without attribution) - it is never silently turned into a valid-looking marker.
      res.redirect(302, affiliate ? `/auth/register?ref=${encodeURIComponent(slug)}` : '/auth/register?ref_invalid=1');
    } catch (error) {
      next(error);
    }
  }
}

export const refController = new RefController();
