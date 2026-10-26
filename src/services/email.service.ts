import { siteUrl } from '../utils/site-url';
import { mailTransporter } from '../utils/mail.transporter';
import { buildOtpEmailHtml } from '../utils/otp-email-template';
import { emailButton, emailFigureCard, emailLead, emailLtr, emailSmall, emailTitle, escHtml, renderEmailShell } from '../utils/email-shell';
import { brandName, brandSubject } from '../utils/brand';
import { transactionalFrom, AUTO_MAIL_HEADERS } from '../utils/email-sender-name';
import { otpValidityText } from '../utils/otp-validity';
import { optionalEmailEnabled } from './optional-email-gate';
import { dispatchMail } from './mail-dispatch';
import { notificationService, notificationMailCopy } from './notification.service';
import { logger } from '../config/logger';

export interface ProjectCompletionRewardEmailData {
  email: string;
  providerName: string;
  projectTitle: string;
  pointsAwarded: number;
  projectUrl: string;
  /** the provider's user id: the optional-mail preference is read for this user (omitted = platform switch only) */
  userId?: string;
  /** the completion event: ONE reward mail per (provider, project) however often the approval is retried */
  projectId?: string;
  /** the PROJECT_COMPLETION_REWARD notification row of the same event: the one-mail claim is stored durably in it */
  notificationId?: string;
}

export class EmailService {
  /** Account-activation code mail (AUTH, never gated). No caller today; kept on the shared shell/sender so a future caller cannot bring back a second design. */
  public async sendOtpEmail(to: string, _firstName: string, otpCode: string, validityMinutes: number = 10): Promise<void> {
    try {
      if (!process.env.SMTP_USER) { logger.warn('Email not sent: SMTP_USER is not configured.'); return; }
      await mailTransporter.sendMail({
        from: await transactionalFrom(),
        to,
        subject: brandSubject('رمز التفعيل الخاص بك - Waseet AI'),
        html: buildOtpEmailHtml(otpCode, validityMinutes, 'activation'),
        text: `رمز تفعيل حسابك في ${brandName()} هو: ${otpCode}\nالرمز صالح لمدة ${otpValidityText(validityMinutes)}. لا تشاركه مع أي أحد. إذا لم تطلبه فتجاهل هذه الرسالة.`,
        headers: { ...AUTO_MAIL_HEADERS },
      });
    } catch (error) {
      logger.error('Failed to send OTP email:', error);
    }
  }

  /** Business-model AI audit result (OPTIONAL, platform switch applies). No caller today. Shared shell; every user text escaped. */
  public async sendModelApprovalEmail(to: string, firstName: string, modelTitle: string, score: number, isApproved: boolean, feedback: string, userId?: string): Promise<void> {
    try {
      if (!(await optionalEmailEnabled())) return;
      // OPTIONAL: the recipient's own e-mail choice also applies (omitted userId = platform switch only)
      if (userId && !(await notificationService.resolveDelivery(userId, '/provider-overview/models', 'MODEL_AUDIT')).channels.email) return;
      const subject = brandSubject(isApproved ? `تم اعتماد نموذج العمل: ${modelTitle} - Waseet AI` : `مراجعة نموذج العمل: ${modelTitle} - Waseet AI`);
      const verdict = isApproved ? 'معتمد ومعروض في السوق' : 'يحتاج إلى تعديل';
      const bodyHtml = `${emailTitle(isApproved ? 'تم اعتماد نموذج العمل' : 'نموذج العمل يحتاج إلى تعديل')}
${emailLead(`${firstName ? `أهلاً ${escHtml(firstName)}،<br>` : ''}تم الانتهاء من فحص نموذج العمل الخاص بك: <strong>${escHtml(modelTitle)}</strong>.`, 16)}
${emailFigureCard({ valueHtml: emailLtr(`${score}%`), captionHtml: escHtml(`${verdict} - تقييم الذكاء`), tone: isApproved ? 'teal' : 'blue' })}
${emailLead(`<strong>الملخص والتوجيهات:</strong><br>${escHtml(feedback)}`, 4)}`;
      const html = renderEmailShell({ lang: 'ar', docTitle: `${modelTitle} - ${brandName()}`, bodyHtml, footerNote: notificationMailCopy('ar').footer });
      if (!process.env.SMTP_USER && !process.env.SMTP_HOST) { logger.info('[Email simulation] Model approval email prepared.'); return; }
      await mailTransporter.sendMail({ from: await transactionalFrom(), to, subject, html, text: `${isApproved ? 'تم اعتماد' : 'مراجعة'} نموذج العمل «${modelTitle}» (${verdict}، ${score}%).\n${feedback}`, headers: { ...AUTO_MAIL_HEADERS } });
    } catch (error) {
      logger.error('Failed to send Model Approval email:', error);
    }
  }

  /**
   * Notify a provider that the client accepted the final delivery and points were awarded. OPTIONAL mail: sent only when the platform's optional-mail switch is ON
   * AND the provider chose e-mail in their notification settings (same resolver as every notification copy). It is THE one mail of this event: the PROJECT_COMPLETION_REWARD
   * notification's e-mail copy is suppressed (mail-dispatch COVERED_NOTIFICATIONS), and a retried approval cannot send it twice.
   */
  public async sendProjectCompletionRewardEmail(data: ProjectCompletionRewardEmailData): Promise<void> {
    const points = Math.max(0, Math.trunc(data.pointsAwarded));
    try {
      if (!(await optionalEmailEnabled())) return;
      if (data.userId) {
        const delivery = await notificationService.resolveDelivery(data.userId, data.projectUrl, 'PROJECT_COMPLETED');
        if (!delivery.channels.email) return;
      }
      const projectUrl = siteUrl(data.projectUrl);
      const bodyHtml = `${emailTitle('مبروك إكمال المشروع')}
${emailLead(`${data.providerName ? `أهلاً ${escHtml(data.providerName)}،<br>` : ''}وافق طالب الخدمة على التسليم النهائي لمشروع «${escHtml(data.projectTitle)}»، وتم إغلاق المشروع بنجاح.`, 16)}
${emailFigureCard({ valueHtml: emailLtr(`+${points}`) + ' نقطة', captionHtml: 'مكافأة إكمال المشروع', lineHtml: 'أُضيفت إلى رصيد نقاطك في المنصة' })}
${projectUrl ? emailButton(projectUrl, 'عرض المشروع والنقاط') : ''}`;
      const htmlContent = renderEmailShell({ lang: 'ar', docTitle: `مبروك إكمال المشروع - ${brandName()}`, bodyHtml, footerNote: notificationMailCopy('ar').footer });
      if (!process.env.SMTP_USER && !process.env.SMTP_HOST) {
        logger.info(`[Email simulation] Project completion reward email prepared (points ${points}).`);
        return;
      }
      const result = await dispatchMail({ transport: mailTransporter,
        purpose: 'project-completion-reward', to: data.email, recipientKey: data.userId ?? data.email,
        eventKey: data.projectId ?? data.notificationId, anchorNotificationId: data.notificationId,
        subject: brandSubject(`تم اعتماد مشروعك وإضافة +${points} نقطة - Waseet AI`),
        html: htmlContent,
        text: `مبروك إكمال المشروع «${data.projectTitle}». أُضيفت +${points} نقطة إلى رصيدك.${projectUrl ? `\n${projectUrl}` : ''}`,
      });
      if (result.status === 'failed') logger.error(`[Email:project-completion] FAILED: ${(result.error as Error)?.message ?? result.error}`);
    } catch (error) {
      logger.error(`[Email:project-completion] FAILED: ${(error as Error)?.message ?? error}`);
    }
  }
}

export const emailService = new EmailService();
