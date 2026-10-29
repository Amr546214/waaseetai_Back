import { otpValidityText } from './otp-validity';
import { escHtml, MAIL_FONT, renderEmailShell } from './email-shell';

/** What a code is for: the title/subtitle of the mail. `generic` keeps the old, purpose-less wording. */
export type OtpEmailPurpose = 'login' | 'activation' | 'register-proof' | 'payment' | 'phone-change' | 'paypal-change' | 'contract-signature' | 'generic';

const COPY: Record<OtpEmailPurpose, { title: string; sub: string }> = {
	login: { title: 'رمز الدخول الخاص بك', sub: 'أدخل الرمز التالي لإتمام تسجيل الدخول' },
	activation: { title: 'رمز تفعيل حسابك', sub: 'أدخل الرمز التالي لتأكيد بريدك الإلكتروني وتفعيل حسابك' },
	'register-proof': { title: 'رمز تأكيد بريدك الإلكتروني', sub: 'أدخل الرمز التالي لتأكيد بريدك وإكمال إنشاء حسابك. لم يُنشأ حساب بعد.' },
	payment: { title: 'رمز تأكيد الدفع', sub: 'أدخل الرمز التالي لتأكيد عملية الدفع' },
	'phone-change': { title: 'رمز تأكيد تغيير رقم الجوال', sub: 'أدخل الرمز التالي لتأكيد تغيير رقم جوالك' },
	'paypal-change': { title: 'رمز تأكيد تغيير بريد PayPal', sub: 'أدخل الرمز التالي لتأكيد تغيير بريد استلام الأرباح' },
	'contract-signature': { title: 'رمز توقيع العقد', sub: 'أدخل الرمز التالي لتأكيد توقيع العقد وإيداع الضمان' },
	generic: { title: 'رمز التحقق الخاص بك', sub: 'أدخل الرمز التالي لإتمام العملية' },
};


/** The e-mail kinds of notification.service.sendOtpMail -> the purpose wording. */
export const otpPurposeOfKind = (kind: string): OtpEmailPurpose =>
	kind === 'login' ? 'login' : kind === 'otp' ? 'activation' : kind === 'register-proof' ? 'register-proof' : kind === 'payment' ? 'payment' : kind === 'phone-change' ? 'phone-change' : kind === 'paypal-email-change' ? 'paypal-change' : 'generic';

/**
 * ONE light, single-column OTP mail for every purpose (the design of the approved reference), built on the shared mail shell. Mail-client safe: table layout,
 * inline styles, no web fonts. The code is ONE text run in a fixed 240px left-to-right box with 22px digits and 4px spacing, all inline: it fits a 320px screen
 * even when the mail app ignores `<style>` / media queries, and the six digits never wrap, clip or scroll.
 * The validity line states the REAL validity of the code it carries.
 */
export const buildOtpEmailHtml = (code: string, validityMinutes: number = 10, purpose: OtpEmailPurpose = 'generic'): string => {
	const copy = COPY[purpose] ?? COPY.generic;
	const bodyHtml = `      <div style="font-family:${MAIL_FONT};font-size:16px;line-height:24px;font-weight:700;color:#111827;margin:0 0 6px 0;">${escHtml(copy.title)}</div>
      <div style="font-family:${MAIL_FONT};font-size:13px;line-height:20px;color:#6b7280;margin:0 0 20px 0;">${escHtml(copy.sub)}</div>
      <table role="presentation" align="center" width="240" cellpadding="0" cellspacing="0" border="0" style="width:240px;margin:0 auto 18px auto;background:#f6f8fb;border:1px solid #e2e6ee;border-radius:8px;">
        <tr><td align="center" style="padding:14px 6px;">
          <div class="ws-code" dir="ltr" style="direction:ltr;unicode-bidi:isolate;white-space:nowrap;font-family:Consolas,'Courier New',monospace;font-size:22px;line-height:28px;font-weight:700;letter-spacing:4px;padding-left:4px;color:#111827;text-align:center;">${escHtml(code)}</div>
        </td></tr>
      </table>
      <div style="font-family:${MAIL_FONT};font-size:12px;line-height:18px;color:#8b93a1;margin:0;">صالح لمدة ${otpValidityText(validityMinutes)}. إذا لم تطلب هذا الرمز، تجاهل هذا البريد.</div>`;
	return renderEmailShell({ lang: 'ar', docTitle: `${copy.title} - Waseet AI`, bodyHtml });
};
