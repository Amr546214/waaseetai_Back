import type { CookieOptions } from 'express';

/**
 * The referral attribution cookie. It is set only by GET /ref/:slug and cleared by
 * POST /api/affiliates/referral-cookie/clear (a visit to /auth/register that did not come from a referral link).
 * Attribution is "current visit": /ref/:slug redirects to /auth/register?ref=1, and any registration page opened
 * without that marker clears the cookie first, so an earlier visit's referrer is never reused.
 */
export const REFERRAL_COOKIE_NAME = 'waseet_ref_code';
export const REFERRAL_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Attributes shared by set and clear: a cookie is only removed when these match what was set. */
export function referralCookieBaseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

export function referralCookieSetOptions(): CookieOptions {
  return { ...referralCookieBaseOptions(), maxAge: REFERRAL_COOKIE_MAX_AGE_MS };
}
