import { emailAssetBaseUrl, siteUrl } from './site-url';
import { brandName } from './brand';
import { getEmailLogoUrl } from '../services/site-identity-cache';

export const escHtml = (v: string): string => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The amount exactly as the code has always written it (en-US digits, 2 decimals, "$" after): currency work is deferred, only the bidi isolation is new. */
export const mailAmountText = (amount: number): string => `${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

/** Footer line of the TRANSACTIONAL mails: they complete an operation and arrive whatever the notification preferences or the optional-mail switch say. */
export const TRANSACTIONAL_FOOTER_NOTE = 'هذه رسالة مطلوبة لإتمام عملية على حسابك؛ تصلك دائمًا ولا تتأثر بإعدادات الإشعارات.';

export const MAIL_FONT = "Tahoma,'Segoe UI',Arial,sans-serif";

/** A solid, bulletproof button (a table cell with a background: it survives mail clients that drop CSS buttons). */
export const emailButton = (href: string, label: string): string => `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td align="center" bgcolor="#1c6fdc" style="background:#1c6fdc;border-radius:8px;"><a href="${escHtml(href)}" target="_blank" style="display:block;padding:13px 30px;font-family:${MAIL_FONT};font-size:15px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${escHtml(label)}</a></td></tr></table>`;

/** Building blocks shared by every body (so no template restyles titles, codes or cards on its own). All inline, table/div only. */
export const emailTitle = (text: string): string => `      <div style="font-family:${MAIL_FONT};font-size:18px;line-height:28px;font-weight:700;color:#111827;margin:0 0 10px 0;">${escHtml(text)}</div>`;
export const emailLead = (html: string, bottom = 18): string => `      <div style="font-family:${MAIL_FONT};font-size:14px;line-height:23px;color:#374151;margin:0 0 ${bottom}px 0;">${html}</div>`;
export const emailSmall = (html: string): string => `      <div style="font-family:${MAIL_FONT};font-size:12px;line-height:19px;color:#8b93a1;margin:0;">${html}</div>`;
/** A number kept in its written order inside RTL text (an isolated left-to-right run): "1,250.00 $" stays "1,250.00 $". */
export const emailLtr = (text: string): string => `<span dir="ltr" style="direction:ltr;unicode-bidi:isolate;white-space:nowrap;">${escHtml(text)}</span>`;
/** The six-digit code box: ONE text run in a fixed 240px left-to-right box (fits a 320px screen, never wraps or clips). */
export const emailCodeBox = (code: string): string => `      <table role="presentation" align="center" width="240" cellpadding="0" cellspacing="0" border="0" style="width:240px;margin:0 auto 18px auto;background:#f6f8fb;border:1px solid #e2e6ee;border-radius:8px;">
        <tr><td align="center" style="padding:14px 6px;">
          <div class="ws-code" dir="ltr" style="direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-family:Consolas,'Courier New',monospace;font-size:22px;line-height:28px;font-weight:700;letter-spacing:4px;padding-left:4px;color:#111827;text-align:center;">${escHtml(code)}</div>
        </td></tr>
      </table>`;
/** A framed key figure (an amount / points) with an optional caption line and a project line; `valueHtml` is already escaped (use emailLtr for numbers). */
export const emailFigureCard = (o: { valueHtml: string; captionHtml?: string; lineHtml?: string; tone?: 'teal' | 'blue' }): string => {
	const c = o.tone === 'blue' ? { bd: '#c9dcf7', bg: '#f1f6fe', fg: '#1c6fdc' } : { bd: '#cfe9e6', bg: '#f2fbfa', fg: '#0f766e' };
	return `      <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 20px auto;max-width:100%;"><tr><td align="center" style="padding:14px 26px;border:1px solid ${c.bd};border-radius:10px;background:${c.bg};font-family:${MAIL_FONT};">
        ${o.captionHtml ? `<div style="font-size:12px;line-height:18px;color:#4b5563;">${o.captionHtml}</div>` : ''}
        <div style="font-size:26px;line-height:34px;font-weight:800;color:${c.fg};">${o.valueHtml}</div>
        ${o.lineHtml ? `<div style="font-size:13px;line-height:20px;color:#374151;margin-top:2px;">${o.lineHtml}</div>` : ''}
      </td></tr></table>`;
};

/**
 * The ONE light shell of every transactional mail: grey page, white bordered card, centered logo + WASEET AI, a body, a footer (optional note, copyright,
 * the help center link). Table layout and inline styles only, no web fonts, no background images. The logo and the help link are left out (never
 * emitted host-less) when the site address is not configured.
 */
export const renderEmailShell = (o: { lang?: 'ar' | 'en'; docTitle: string; bodyHtml: string; footerNote?: string; padStyle?: string }): string => {
	const dir = o.lang === 'en' ? 'ltr' : 'rtl';
	const assets = emailAssetBaseUrl();
	// the identity's logo.email when the owner replaced it (absolute URL from the in-process cache), else EXACTLY the long-standing default
	const mark = getEmailLogoUrl() ?? (assets ? `${assets}/images/waseet-mark.png` : null);
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
      ${mark ? `<img src="${escHtml(mark)}" width="34" alt="${escHtml(brandName())}" style="display:block;margin:0 auto 14px auto;border:0;outline:none;height:auto;">` : ''}
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
