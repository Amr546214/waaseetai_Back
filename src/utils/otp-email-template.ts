import { otpValidityText } from './otp-validity';

/** What a code is for: the title/subtitle of the mail. `generic` keeps the old, purpose-less wording. */
export type OtpEmailPurpose = 'login' | 'activation' | 'payment' | 'phone-change' | 'paypal-change' | 'contract-signature' | 'generic';

const COPY: Record<OtpEmailPurpose, { title: string; sub: string }> = {
	login: { title: 'رمز الدخول الخاص بك', sub: 'أدخل الرمز التالي لإتمام تسجيل الدخول' },
	activation: { title: 'رمز تفعيل حسابك', sub: 'أدخل الرمز التالي لتأكيد بريدك الإلكتروني وتفعيل حسابك' },
	payment: { title: 'رمز تأكيد الدفع', sub: 'أدخل الرمز التالي لتأكيد عملية الدفع' },
	'phone-change': { title: 'رمز تأكيد تغيير رقم الجوال', sub: 'أدخل الرمز التالي لتأكيد تغيير رقم جوالك' },
	'paypal-change': { title: 'رمز تأكيد تغيير بريد PayPal', sub: 'أدخل الرمز التالي لتأكيد تغيير بريد استلام الأرباح' },
	'contract-signature': { title: 'رمز توقيع العقد', sub: 'أدخل الرمز التالي لتأكيد توقيع العقد وإيداع الضمان' },
	generic: { title: 'رمز التحقق الخاص بك', sub: 'أدخل الرمز التالي لإتمام العملية' },
};

const esc = (v: string): string => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The e-mail kinds of notification.service.sendOtpMail -> the purpose wording. */
export const otpPurposeOfKind = (kind: string): OtpEmailPurpose =>
	kind === 'login' ? 'login' : kind === 'otp' ? 'activation' : kind === 'payment' ? 'payment' : kind === 'phone-change' ? 'phone-change' : kind === 'paypal-email-change' ? 'paypal-change' : 'generic';

const base = (): string => (process.env.FRONTEND_URL || 'https://waseet.ai').replace(/\/$/, '');

/**
 * ONE light, single-column OTP mail for every purpose (the design of the approved reference). Mail-client safe: table layout, inline styles, no web fonts, no
 * background images, an absolute https logo with alt text. The code is ONE text run in a left-to-right box (copy/paste stays one number); its size and
 * letter-spacing shrink on narrow screens, and it is `nowrap` inside a box that always fits 264px, so the six digits never wrap, clip or scroll.
 * The validity line states the REAL validity of the code it carries.
 */
export const buildOtpEmailHtml = (code: string, validityMinutes: number = 10, purpose: OtpEmailPurpose = 'generic'): string => {
	const copy = COPY[purpose] ?? COPY.generic;
	const b = base();
	const year = new Date().getFullYear();
	const help = `${b}/support/help-center`;
	const unsub = process.env.EMAIL_UNSUBSCRIBE_URL || help;
	const font = "Tahoma,'Segoe UI',Arial,sans-serif";
	return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(copy.title)} - Waseet AI</title>
<style>
@media only screen and (max-width:400px){
  .ws-pad{padding:20px 14px !important}
  .ws-code{font-size:22px !important;letter-spacing:5px !important;padding-left:5px !important}
}
@media only screen and (max-width:340px){
  .ws-code{font-size:19px !important;letter-spacing:3px !important;padding-left:3px !important}
}
</style>
</head>
<body style="margin:0;padding:0;background:#f1f4f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f4f9;">
<tr><td align="center" style="padding:20px 8px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e3e7ee;border-radius:10px;">
    <tr><td align="center" style="padding:26px 20px 18px 20px;border-bottom:1px solid #eceff4;font-family:${font};">
      <img src="${esc(b)}/images/waseet-mark.png" width="34" alt="Waseet AI" style="display:block;margin:0 auto 14px auto;border:0;outline:none;height:auto;">
      <div style="font-family:${font};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;color:#4b5563;">WASEET AI</div>
    </td></tr>
    <tr><td class="ws-pad" align="center" style="padding:30px 24px 26px 24px;font-family:${font};">
      <div style="font-family:${font};font-size:16px;line-height:24px;font-weight:700;color:#111827;margin:0 0 6px 0;">${esc(copy.title)}</div>
      <div style="font-family:${font};font-size:13px;line-height:20px;color:#6b7280;margin:0 0 20px 0;">${esc(copy.sub)}</div>
      <table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:240px;margin:0 auto 18px auto;background:#f6f8fb;border:1px solid #e2e6ee;border-radius:8px;">
        <tr><td align="center" style="padding:14px 6px;">
          <div class="ws-code" dir="ltr" style="direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-family:Consolas,'Courier New',monospace;font-size:26px;line-height:32px;font-weight:700;letter-spacing:8px;padding-left:8px;color:#111827;text-align:center;">${esc(code)}</div>
        </td></tr>
      </table>
      <div style="font-family:${font};font-size:12px;line-height:18px;color:#8b93a1;margin:0;">صالح لمدة ${otpValidityText(validityMinutes)}. إذا لم تطلب هذا الرمز، تجاهل هذا البريد.</div>
    </td></tr>
    <tr><td align="center" style="padding:18px 20px 20px 20px;border-top:1px solid #eceff4;font-family:${font};">
      <div style="font-family:${font};font-size:11px;line-height:16px;color:#9aa1ae;margin:0 0 6px 0;">&copy; Waseet AI ${year} &ndash; جميع الحقوق محفوظة</div>
      <div style="font-family:${font};font-size:11px;line-height:16px;color:#9aa1ae;margin:0;"><a href="${esc(help)}" style="color:#4b5563;text-decoration:none;font-weight:600;">مركز المساعدة</a> &nbsp;&middot;&nbsp; <a href="${esc(unsub)}" style="color:#4b5563;text-decoration:none;font-weight:600;">إلغاء الاشتراك</a></div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
};
