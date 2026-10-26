import { siteUrl } from '../utils/site-url';
import nodemailer from 'nodemailer';
import { mailTransporter } from '../utils/mail.transporter';
import { emailButton, MAIL_FONT, renderEmailShell } from '../utils/email-shell';
import { brandName, brandSubject } from '../utils/brand';
import { emailSenderName } from '../utils/email-sender-name';
import { optionalEmailEnabled } from './optional-email-gate';
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
}

const escapeHtml = (value: string): string => value.replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[character] || character));

export class EmailService {
  private transporter: nodemailer.Transporter;

  constructor() {
    // Configure SMTP details here (usually provided via .env)
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  /**
   * Generates a premium HTML template for the OTP email
   */
  private getOtpEmailTemplate(firstName: string, otpCode: string): string {
    return `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>رمز التفعيل - وسيط AI</title>
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background-color: #F6F8FC;
          margin: 0;
          padding: 0;
          color: #070D24;
        }
        .container {
          max-width: 600px;
          margin: 40px auto;
          background: #ffffff;
          border-radius: 16px;
          box-shadow: 0 10px 30px rgba(7, 13, 36, 0.05);
          overflow: hidden;
          border: 1px solid #E7EAF1;
        }
        .header {
          background: linear-gradient(135deg, #2BD4C7 0%, #2B7FFF 100%);
          padding: 30px 20px;
          text-align: center;
        }
        .header h1 {
          color: #ffffff;
          margin: 0;
          font-size: 28px;
          font-weight: 900;
        }
        .content {
          padding: 40px 30px;
          text-align: center;
        }
        .greeting {
          font-size: 20px;
          font-weight: 700;
          margin-bottom: 20px;
          color: #070D24;
        }
        .message {
          font-size: 16px;
          color: #56607D;
          line-height: 1.6;
          margin-bottom: 30px;
        }
        .otp-box {
          background: rgba(43, 212, 199, 0.08);
          border: 1px solid rgba(43, 212, 199, 0.3);
          border-radius: 12px;
          padding: 20px;
          margin: 0 auto 30px;
          max-width: 300px;
        }
        .otp-code {
          font-size: 36px;
          font-weight: 900;
          color: #2B7FFF;
          letter-spacing: 8px;
          margin: 0;
        }
        .warning {
          font-size: 13px;
          color: #6B7699;
          margin-bottom: 20px;
        }
        .footer {
          background: #F6F8FC;
          padding: 20px;
          text-align: center;
          font-size: 13px;
          color: #6B7699;
          border-top: 1px solid #E7EAF1;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>وسيط AI</h1>
        </div>
        <div class="content">
          <div class="greeting">أهلاً بك، ${firstName} 👋</div>
          <div class="message">
            شكرًا لتسجيلك في منصة وسيط AI. لإكمال عملية التسجيل وتفعيل حسابك، يرجى استخدام رمز التحقق التالي:
          </div>
          
          <div class="otp-box">
            <p class="otp-code">${otpCode}</p>
          </div>
          
          <div class="warning">
            هذا الرمز صالح لمدة <strong>5 دقائق</strong> فقط. يرجى عدم مشاركة هذا الرمز مع أي شخص.
          </div>
        </div>
        <div class="footer">
          &copy; ${new Date().getFullYear()} وسيط AI. جميع الحقوق محفوظة.
        </div>
      </div>
    </body>
    </html>
    `;
  }

  /**
   * Sends an OTP verification email
   */
  public async sendOtpEmail(to: string, firstName: string, otpCode: string): Promise<void> {
    try {
      const htmlContent = this.getOtpEmailTemplate(firstName, otpCode);

      if (!process.env.SMTP_USER) {
        logger.warn('Email not sent: SMTP_USER is not configured.');
        return;
      }

      await this.transporter.sendMail({
        from: `"وسيط AI" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
        to,
        subject: 'رمز التفعيل الخاص بك - وسيط AI',
        html: htmlContent,
      });

      logger.info(`✅ OTP Email successfully sent to ${to}`);
    } catch (error) {
      logger.error('❌ Failed to send OTP email:', error);
    }
  }

  /**
   * Sends an automated notification email for Business Model AI Audit results
   */
  public async sendModelApprovalEmail(to: string, firstName: string, modelTitle: string, score: number, isApproved: boolean, feedback: string): Promise<void> {
    try {
      // OPTIONAL mail (no caller today): the platform switch applies; names / texts are escaped
      if (!(await optionalEmailEnabled())) return;
      firstName = escapeHtml(firstName); modelTitle = escapeHtml(modelTitle); feedback = escapeHtml(feedback);
      const subject = isApproved 
        ? `🎉 تم اعتماد نموذج العمل: ${modelTitle} - وسيط AI` 
        : `⚠️ مراجعة نموذج العمل: ${modelTitle} - وسيط AI`;
        
      const htmlContent = `
      <!DOCTYPE html>
      <html lang="ar" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #F6F8FC; margin: 0; padding: 0; color: #070D24; }
          .container { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 16px; padding: 30px; border: 1px solid #E7EAF1; }
          .header { text-align: center; padding-bottom: 20px; border-bottom: 1px solid #E7EAF1; }
          .badge { display: inline-block; padding: 8px 16px; border-radius: 20px; font-weight: bold; margin: 15px 0; color: #fff; background: ${isApproved ? '#2BD4C7' : '#FF6B6B'}; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header"><h2>وسيط AI - مركز النماذج والخدمات</h2></div>
          <h3>أهلاً ${firstName} 👋</h3>
          <p>تم الانتهاء من فحص وتدقيق نموذج العمل الخاص بك: <strong>${modelTitle}</strong> عبر نظام الذكاء الاصطناعي في وسيط.</p>
          <div class="badge">${isApproved ? 'معتمد ومعروض في السوق 🟢' : 'يحتاج إلى تعديل 🔴'} - تقييم الذكاء: ${score}%</div>
          <p><strong>الملخص والتوجيهات:</strong><br/>${feedback}</p>
          <p>يمكنك التوجه إلى لوحة التحكم لمعرفة المزيد من التفاصيل وإدارة النماذج والخدمات الخاصة بك.</p>
        </div>
      </body>
      </html>
      `;

      if (!process.env.SMTP_USER) {
        logger.info(`[Email simulation] ${subject} sent to ${to}. Content Summary: ${feedback}`);
        return;
      }

      await this.transporter.sendMail({
        from: `"وسيط AI" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
        to,
        subject,
        html: htmlContent,
      });
      logger.info(`✅ Model Approval Email successfully sent to ${to}`);
    } catch (error) {
      logger.error('❌ Failed to send Model Approval email:', error);
    }
  }

  /**
   * Notify a provider that the client accepted the final delivery and points were awarded. OPTIONAL mail: sent only when the platform's optional-mail switch is ON
   * AND the provider chose e-mail in their notification settings (same resolver as every notification copy). Branded with the configured platform name, on the shared shell.
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
      const font = MAIL_FONT;
      const bodyHtml = `      <div style="font-family:${font};font-size:13px;line-height:20px;color:#6b7280;margin:0 0 10px 0;">أهلاً ${escapeHtml(data.providerName)}</div>
      <div style="font-family:${font};font-size:18px;line-height:28px;font-weight:700;color:#111827;margin:0 0 10px 0;">مبروك إكمال المشروع</div>
      <div style="font-family:${font};font-size:14px;line-height:23px;color:#374151;margin:0 0 18px 0;">وافق طالب الخدمة على التسليم النهائي لمشروع «${escapeHtml(data.projectTitle)}»، وتم إغلاق المشروع بنجاح.</div>
      <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto ${projectUrl ? '24px' : '4px'} auto;"><tr><td align="center" style="padding:14px 28px;border:1px solid #cfe9e6;border-radius:10px;background:#f2fbfa;font-family:${font};">
        <div style="font-size:12px;line-height:18px;color:#4b5563;">مكافأة إكمال المشروع</div>
        <div style="font-size:26px;line-height:34px;font-weight:800;color:#0f766e;">+${points} نقطة</div>
        <div style="font-size:12px;line-height:18px;color:#6b7280;">أُضيفت إلى رصيد نقاطك في المنصة</div>
      </td></tr></table>
      ${projectUrl ? emailButton(projectUrl, 'عرض المشروع والنقاط') : ''}`;
      const htmlContent = renderEmailShell({ lang: 'ar', docTitle: `مبروك إكمال المشروع - ${brandName()}`, bodyHtml, footerNote: notificationMailCopy('ar').footer });
      if (!process.env.SMTP_USER && !process.env.SMTP_HOST) {
        logger.info(`[Email simulation] Project completion reward email prepared (points ${points}).`);
        return;
      }
      await mailTransporter.sendMail({
        from: `"${await emailSenderName()}" <${process.env.SMTP_FROM ?? 'no-reply@waseetai.com'}>`,
        to: data.email,
        subject: brandSubject(`تم اعتماد مشروعك وإضافة +${points} نقطة - Waseet AI`),
        html: htmlContent,
        text: `مبروك إكمال المشروع «${data.projectTitle}». أُضيفت +${points} نقطة إلى رصيدك.${projectUrl ? `\n${projectUrl}` : ''}`,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
      });
    } catch (error) {
      logger.error(`[Email:project-completion] FAILED: ${(error as Error)?.message ?? error}`);
    }
  }
}

export const emailService = new EmailService();
