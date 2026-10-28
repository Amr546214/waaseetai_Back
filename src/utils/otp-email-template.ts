import { otpValidityText } from './otp-validity';
import { brandName } from './brand';
import { emailCodeBox, escHtml, MAIL_FONT, renderEmailShell } from './email-shell';

/** What a code is for: the title/subtitle of the mail. `generic` keeps the old, purpose-less wording. */
export type OtpEmailPurpose = 'login' | 'activation' | 'register-proof' | 'payment' | 'phone-change' | 'paypal-change' | 'contract-signature' | 'admin-invite' | 'generic';

const COPY: Record<OtpEmailPurpose, { title: string; sub: string }> = {
	login: { title: 'رمز الدخول الخاص بك', sub: 'أدخل الرمز التالي لإتمام تسجيل الدخول' },
	activation: { title: 'رمز تفعيل حسابك', sub: 'أدخل الرمز التالي لتأكيد بريدك الإلكتروني وتفعيل حسابك' },
	'register-proof': { title: 'رمز تأكيد بريدك الإلكتروني', sub: 'أدخل الرمز التالي لتأكيد بريدك وإكمال إنشاء حسابك. لم يُنشأ حساب بعد.' },
	payment: { title: 'رمز تأكيد الدفع', sub: 'أدخل الرمز التالي لتأكيد عملية الدفع' },
	'phone-change': { title: 'رمز تأكيد تغيير رقم الجوال', sub: 'أدخل الرمز التالي لتأكيد تغيير رقم جوالك' },
	'paypal-change': { title: 'رمز تأكيد تغيير بريد PayPal', sub: 'أدخل الرمز التالي لتأكيد تغيير بريد استلام الأرباح' },
	'contract-signature': { title: 'رمز توقيع العقد', sub: 'أدخل الرمز التالي لتأكيد توقيع العقد وإيداع الضمان' },
	'admin-invite': { title: 'رمز قبول دعوة فريق الإدارة', sub: 'أدخل الرمز التالي لتأكيد بريدك وقبول الدعوة' },
	generic: { title: 'رمز التحقق الخاص بك', sub: 'أدخل الرمز التالي لإتمام العملية' },
};


/** The e-mail kinds of notification.service.sendOtpMail -> the purpose wording. */
export const otpPurposeOfKind = (kind: string): OtpEmailPurpose =>
	kind === 'login' ? 'login' : kind === 'otp' ? 'activation' : kind === 'register-proof' ? 'register-proof' : kind === 'payment' ? 'payment' : kind === 'phone-change' ? 'phone-change' : kind === 'paypal-email-change' ? 'paypal-change' : kind === 'admin-invite' ? 'admin-invite' : 'generic';

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
${emailCodeBox(code)}
      <div style="font-family:${MAIL_FONT};font-size:12px;line-height:18px;color:#8b93a1;margin:0;">صالح لمدة ${otpValidityText(validityMinutes)}. لا تشاركه مع أي أحد. إذا لم تطلب هذا الرمز، تجاهل هذا البريد.</div>`;
	return renderEmailShell({ lang: 'ar', docTitle: `${copy.title} - ${brandName()}`, bodyHtml });
};
