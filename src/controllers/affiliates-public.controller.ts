import { Request, Response, NextFunction } from 'express';
import { affiliatesPublicService } from '../services/affiliates-public.service';
import { AppError } from '../utils/app-error';
import { getRequestCookie } from '../utils/request-cookie';
import { REFERRAL_COOKIE_NAME, referralCookieBaseOptions } from '../utils/referral-cookie';

export class AffiliatesPublicController {
  public async resolve(req: Request, res: Response, next: NextFunction) {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code.trim()) {
        throw new AppError('كود الإحالة مطلوب', 400);
      }

      const affiliate = await affiliatesPublicService.resolveByCode(code);
      if (!affiliate) {
        throw new AppError('لم يتم العثور على وسيط بهذا الكود', 404);
      }

      res.status(200).json({ success: true, data: affiliate });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/affiliates/referral-status — the frontend cannot read the
   * httpOnly waseet_ref_code cookie itself (correctly — it's not made
   * readable to JS for this), so it asks the backend, server-side, whether a
   * valid referral-cookie attribution currently exists. ALWAYS 200 — absent
   * or stale/invalid cookie is `{ active: false }`, never a 404/error; only
   * the `active` boolean (plus, when true, the same PII-safe
   * { referralSlug, displayName } shape as resolve()/search()) carries the
   * result.
   */
  public async referralStatus(req: Request, res: Response, next: NextFunction) {
    try {
      // Manual cookie-header parsing — same as ref.controller.ts/
      // auth.controller.ts. This codebase has no cookie-parser middleware
      // registered, so req.cookies is always undefined.
      const cookieSlug = getRequestCookie(req, 'waseet_ref_code');
      const data = await affiliatesPublicService.getReferralStatus(cookieSlug);

      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/affiliates/referral-cookie/clear — the registration page opened WITHOUT a referral-link marker
   * (?ref=1) calls this so an older visit's waseet_ref_code is removed (current-visit attribution): the page then shows
   * no locked referrer and the registration cannot be attributed from the stale cookie. Idempotent, always 200,
   * removes the cookie with the same attributes it was set with. Public (no auth) like the rest of this router.
   */
  public async clearReferralCookie(_req: Request, res: Response, next: NextFunction) {
    try {
      res.clearCookie(REFERRAL_COOKIE_NAME, referralCookieBaseOptions());
      res.status(200).json({ success: true, data: { cleared: true } });
    } catch (error) {
      next(error);
    }
  }

  public async search(req: Request, res: Response, next: NextFunction) {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      const results = await affiliatesPublicService.search(query);

      res.status(200).json({ success: true, data: results });
    } catch (error) {
      next(error);
    }
  }
}

export const affiliatesPublicController = new AffiliatesPublicController();
