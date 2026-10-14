import type { CookieOptions } from 'express';

/**
 * The referral attribution cookie. It is set only by GET /ref/:slug and cleared by
 * POST /api/affiliates/referral-cookie/clear (a visit to /auth/register that did not come from a referral link).
 * Attribution is "current visit": /ref/:slug redirects to /auth/register?ref=<slug>, and any registration page opened
 * without a ref marker clears the cookie first, so an earlier visit's referrer is never reused.
 */
export const REFERRAL_COOKIE_NAME = 'waseet_ref_code';
/** The channel (SourceChannel enum value) of the link that set the referral cookie; stored on Referral.sourceChannel at sign-up. */
export const REFERRAL_SOURCE_COOKIE_NAME = 'waseet_ref_src';
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
