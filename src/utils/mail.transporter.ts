import nodemailer from 'nodemailer';
import { otpValidityText } from './otp-validity';
import { buildOtpEmailHtml, type OtpEmailPurpose } from './otp-email-template';
import { TRANSACTIONAL_FOOTER_NOTE, mailAmountText, emailButton, emailCodeBox, emailFigureCard, emailLead, emailLtr, emailSmall, emailTitle, renderEmailShell } from './email-shell';
import { brandNameInArabicText } from './brand';
import { escHtml } from './email-shell';

// SMTP Configuration
const smtpConfig = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
};

// Create transporter
// Bounded timeouts: a hanging SMTP connection must fail (and be reported as emailSent:false) instead of waiting minutes.
export const mailTransporter = nodemailer.createTransport({
  ...smtpConfig,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
});

// Waseet AI Verification Email Template: ONE light design for every shared-template OTP mail (see otp-email-template.ts); `purpose` only changes the title/subtitle.
export const getOtpEmailTemplate = (code: string, validityMinutes: number = 10, purpose: OtpEmailPurpose = 'generic') => buildOtpEmailHtml(code, validityMinutes, purpose);

// Password reset: the shared shell, the code box and the security wording (validity, ignore if not requested). An AUTH mail: never gated.
export const getPasswordResetEmailTemplate = (firstName: string, code: string, validityMinutes: number = 10) => {
  const name = String(firstName || '').trim();
  const bodyHtml = `${emailTitle('طلب إعادة تعيين كلمة المرور')}
${emailLead(`${name ? `أهلاً ${escHtml(name)}،<br>` : ''}وصلنا طلب لإعادة تعيين كلمة المرور الخاصة بحسابك في منصة ${escHtml(brandNameInArabicText())}. استخدم الرمز التالي لمتابعة العملية:`, 20)}
${emailCodeBox(code)}
${emailSmall(`صالح لمدة ${otpValidityText(validityMinutes)}. لا تشاركه مع أي أحد. إذا لم تطلب إعادة تعيين كلمة المرور فتجاهل هذه الرسالة، ولن يتغيّر شيء في حسابك.`)}`;
  return renderEmailShell({ lang: 'ar', docTitle: `إعادة تعيين كلمة المرور - ${brandNameInArabicText()}`, bodyHtml });
};

// Escrow deposit receipt (TRANSACTIONAL, to the client). Carries everything the ESCROW_FUNDED in-app copy says, so that copy is not mailed a second time.
export const getDepositConfirmationTemplate = (projectName: string, amount: number, linkUrl: string | null = null) => {
  const bodyHtml = `${emailTitle('تم إيداع الضمان بنجاح')}
${emailLead(`تم تأكيد استلام الدفعة وحجزها في حساب الضمان الآمن الخاص بمنصة ${escHtml(brandNameInArabicText())} للمشروع التالي:`, 16)}
${emailFigureCard({ valueHtml: emailLtr(mailAmountText(amount)), captionHtml: 'المبلغ المحجوز في الضمان', lineHtml: `مشروع: ${escHtml(projectName)}` })}
${emailLead(`يبدأ التنفيذ عندما يوقّع مقدّم الخدمة العقد. سيبقى المبلغ محفوظًا لدينا ولن يُحوَّل لمقدّم الخدمة إلا بعد استلامك للمشروع واعتمادك النهائي له.`, linkUrl ? 22 : 4)}
${linkUrl ? emailButton(linkUrl, 'عرض مشاريعي') : ''}`;
  return renderEmailShell({ lang: 'ar', docTitle: `تأكيد إيداع الضمان - ${brandNameInArabicText()}`, bodyHtml, footerNote: TRANSACTIONAL_FOOTER_NOTE });
};

// Contract-signature invitation (TRANSACTIONAL, to the provider). Carries everything the OFFER_ACCEPTED in-app copy says (client name, amount, the sign link).
export const getProviderContractSignatureTemplate = (projectName: string, clientName: string, amount: number, linkUrl: string | null = null) => {
  const client = String(clientName || '').trim();
  const bodyHtml = `${emailTitle('دعوة لتوقيع العقد')}
${emailLead(`تم قبول عرضك${client ? ` من العميل ${escHtml(client)}` : ''} وإيداع قيمة المشروع في حساب الضمان الآمن الخاص بمنصة ${escHtml(brandNameInArabicText())}.`, 16)}
${emailFigureCard({ valueHtml: emailLtr(mailAmountText(amount)), captionHtml: 'قيمة العقد المودعة في الضمان', lineHtml: `مشروع: ${escHtml(projectName)}`, tone: 'blue' })}
${emailLead(`يرجى الدخول إلى حسابك في المنصة وتوقيع العقد للبدء في تنفيذ المشروع.`, linkUrl ? 22 : 4)}
${linkUrl ? emailButton(linkUrl, 'عرض وتوقيع العقد') : ''}`;
  return renderEmailShell({ lang: 'ar', docTitle: `توقيع عقد مشروع جديد - ${brandNameInArabicText()}`, bodyHtml, footerNote: TRANSACTIONAL_FOOTER_NOTE });
};
