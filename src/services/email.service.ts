import nodemailer from 'nodemailer';
import { logger } from '../config/logger';

export interface ProjectCompletionRewardEmailData {
  email: string;
  providerName: string;
  projectTitle: string;
  pointsAwarded: number;
  projectUrl: string;
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
        logger.warn(`Email not sent: SMTP_USER is not configured. OTP for ${to} is ${otpCode}`);
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

  /** Notify a provider that the client accepted the final delivery and points were awarded. */
  public async sendProjectCompletionRewardEmail(data: ProjectCompletionRewardEmailData): Promise<void> {
    const providerName = escapeHtml(data.providerName);
    const projectTitle = escapeHtml(data.projectTitle);
    const points = Math.max(0, Math.trunc(data.pointsAwarded));
    const frontendBaseUrl = (process.env.FRONTEND_URL || 'https://waseet.ai').replace(/\/$/, '');
    const projectUrl = `${frontendBaseUrl}${data.projectUrl.startsWith('/') ? data.projectUrl : `/${data.projectUrl}`}`;
    const subject = `🎉 تم اعتماد مشروعك وإضافة +${points} نقطة - وسيط AI`;
    const htmlContent = `
      <!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{margin:0;padding:24px;background:#f6f8fc;color:#070d24;font-family:'Segoe UI',Tahoma,Arial,sans-serif}.card{max-width:600px;margin:auto;overflow:hidden;border:1px solid #e7eaf1;border-radius:18px;background:#fff}.header{padding:28px;text-align:center;background:linear-gradient(135deg,#2bd4c7,#2b7fff);color:#fff}.content{padding:32px}.points{margin:24px 0;padding:20px;text-align:center;border:1px solid rgba(43,212,199,.35);border-radius:14px;background:rgba(43,212,199,.08)}.points b{display:block;font-size:34px;color:#0fa99a}.button{display:block;padding:13px 18px;border-radius:11px;background:#2b7fff;color:#fff!important;text-align:center;text-decoration:none;font-weight:800}.footer{padding:18px;background:#f8fafc;color:#6b7699;text-align:center;font-size:12px}
      </style></head><body><div class="card"><div class="header"><h1>مبروك إكمال المشروع 🎉</h1></div><div class="content">
      <h3>أهلاً ${providerName}</h3><p>وافق طالب الخدمة على التسليم النهائي لمشروع <strong>«${projectTitle}»</strong>، وتم إغلاق المشروع بنجاح.</p>
      <div class="points"><span>مكافأة إكمال المشروع</span><b>+${points} نقطة</b><small>أُضيفت مباشرة إلى رصيد نقاطك في المنصة</small></div>
      <a class="button" href="${projectUrl}">عرض المشروع والنقاط</a></div><div class="footer">وسيط AI — منصة العمل والخدمات المحمية</div></div></body></html>`;

    try {
      if (!process.env.SMTP_USER && !process.env.SMTP_HOST) {
        logger.info(`[Email simulation] Project completion reward email prepared for ${data.email}. Points: ${points}`);
        return;
      }
      await this.transporter.sendMail({
        from: `"وسيط AI" <${process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@waseet.ai'}>`,
        to: data.email,
        subject,
        html: htmlContent
      });
      logger.info(`✅ Project completion reward email sent to ${data.email}`);
    } catch (error) {
      logger.error(`❌ Failed to send project completion reward email to ${data.email}:`, error);
    }
  }
}

export const emailService = new EmailService();
