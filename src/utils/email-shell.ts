import { emailAssetBaseUrl, siteUrl } from './site-url';
import { brandName } from './brand';

export const escHtml = (v: string): string => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const MAIL_FONT = "Tahoma,'Segoe UI',Arial,sans-serif";

/** A solid, bulletproof button (a table cell with a background: it survives mail clients that drop CSS buttons). */
export const emailButton = (href: string, label: string): string => `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td align="center" bgcolor="#1c6fdc" style="background:#1c6fdc;border-radius:8px;"><a href="${escHtml(href)}" target="_blank" style="display:block;padding:13px 30px;font-family:${MAIL_FONT};font-size:15px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${escHtml(label)}</a></td></tr></table>`;

/**
 * The ONE light shell of every transactional mail: grey page, white bordered card, centered logo + WASEET AI, a body, a footer (optional note, copyright,
 * the help center link). Table layout and inline styles only, no web fonts, no background images. The logo and the help link are left out (never
 * emitted host-less) when the site address is not configured.
 */
export const renderEmailShell = (o: { lang?: 'ar' | 'en'; docTitle: string; bodyHtml: string; footerNote?: string; padStyle?: string }): string => {
	const dir = o.lang === 'en' ? 'ltr' : 'rtl';
	const assets = emailAssetBaseUrl();
	const help = siteUrl('/support/help-center');
	const year = new Date().getFullYear();
	const helpLabel = o.lang === 'en' ? 'Help center' : 'مركز المساعدة';
	const rights = o.lang === 'en' ? 'All rights reserved' : 'جميع الحقوق محفوظة';
	return `<!DOCTYPE html>
<html lang="${o.lang === 'en' ? 'en' : 'ar'}" dir="${dir}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escHtml(o.docTitle)}</title>
<style>
@media only screen and (max-width:400px){
  .ws-pad{padding:20px 14px !important}
}
</style>
</head>
<body style="margin:0;padding:0;background:#f1f4f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f4f9;">
<tr><td align="center" style="padding:20px 8px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e3e7ee;border-radius:10px;">
    <tr><td align="center" style="padding:26px 20px 18px 20px;border-bottom:1px solid #eceff4;font-family:${MAIL_FONT};">
      ${assets ? `<img src="${escHtml(assets)}/images/waseet-mark.png" width="34" alt="${escHtml(brandName())}" style="display:block;margin:0 auto 14px auto;border:0;outline:none;height:auto;">` : ''}
      <div style="font-family:${MAIL_FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;color:#4b5563;">${escHtml(brandName().toUpperCase())}</div>
    </td></tr>
    <tr><td class="ws-pad" align="center" style="${o.padStyle ?? 'padding:30px 24px 26px 24px;'}font-family:${MAIL_FONT};">
${o.bodyHtml}
    </td></tr>
    <tr><td align="center" style="padding:18px 20px 20px 20px;border-top:1px solid #eceff4;font-family:${MAIL_FONT};">
      ${o.footerNote ? `<div style="font-family:${MAIL_FONT};font-size:11px;line-height:17px;color:#9aa1ae;margin:0 0 8px 0;">${escHtml(o.footerNote)}</div>` : ''}
      <div style="font-family:${MAIL_FONT};font-size:11px;line-height:16px;color:#9aa1ae;margin:0 0 6px 0;">&copy; ${escHtml(brandName())} ${year} &ndash; ${rights}</div>
      ${help ? `<div style="font-family:${MAIL_FONT};font-size:11px;line-height:16px;margin:0;"><a href="${escHtml(help)}" style="color:#4b5563;text-decoration:none;font-weight:600;">${helpLabel}</a></div>` : ''}
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
};
