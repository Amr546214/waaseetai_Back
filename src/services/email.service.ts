import nodemailer from 'nodemailer';
import { logger } from '../config/logger';

export interface SpecialtyQuizResultEmailData {
  email: string;
  providerName: string;
  specialtyName: string;
  subSpecialties: string[];
  scorePercentage: number;
  correctAnswers: number;
  totalQuestions: number;
  passed: boolean;
  status: string;
  lockoutUntil?: Date | string | null;
  violationCount?: number;
  isInvalidated?: boolean;
  isTimedOut?: boolean;
}

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
   * Generates a professional Cyber-Creative HTML template for Specialty Quiz Verification Results
   */
  private getSpecialtyQuizResultTemplate(data: SpecialtyQuizResultEmailData): string {
    const isSuccess = data.passed && !data.isInvalidated && !data.isTimedOut;
    const badgeBg = isSuccess ? 'linear-gradient(135deg, #2BD4C7 0%, #2B7FFF 100%)' : 'linear-gradient(135deg, #FF6B6B 0%, #D98A0B 100%)';
    const badgeColor = isSuccess ? '#070D24' : '#ffffff';
    const statusLabel = isSuccess 
      ? '🏅 تم اجتياز الاختبار بنجاح - شارة التميز مفعلة' 
      : (data.isInvalidated ? '🚨 أُبطل الاختبار بسبب مخالفة شروط مكافحة الغش' : (data.isTimedOut ? '⏱️ انتهى وقت الاختبار قبل إتمام النتيجة المطلوبة' : '⚠️ لم تتجاوز نسبة النجاح المشروطة (25%)'));

    const subSpecialtyBadges = (data.subSpecialties || []).map(s => 
      `<span style="display:inline-block; background:rgba(123,47,190,0.12); color:#7B2FBE; border:1px solid rgba(123,47,190,0.3); border-radius:8px; padding:4px 12px; margin:3px; font-size:12px; font-weight:bold;">${s}</span>`
    ).join('');

    return `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>نتيجة اختبار تخصص ${data.specialtyName} - وسيط AI</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #F0F3F9; margin: 0; padding: 0; color: #070D24; }
        .wrapper { width: 100%; padding: 30px 15px; background-color: #F0F3F9; box-sizing: border-box; }
        .container { max-width: 650px; margin: 0 auto; background: #ffffff; border-radius: 20px; box-shadow: 0 15px 40px rgba(7, 13, 36, 0.08); overflow: hidden; border: 1px solid #E4E8F2; }
        .header { background: #070D24; padding: 35px 25px; text-align: center; border-bottom: 4px solid ${isSuccess ? '#2BD4C7' : '#FF6B6B'}; position: relative; }
        .header h1 { color: #ffffff; margin: 0; font-size: 26px; font-weight: 900; letter-spacing: -0.5px; }
        .header p { color: #8F9A8A; color: #8A98BC; font-size: 14px; margin: 8px 0 0 0; font-weight: 600; }
        .content { padding: 40px 35px; text-align: right; }
        .greeting { font-size: 22px; font-weight: 800; margin-bottom: 15px; color: #070D24; }
        .intro-text { font-size: 15px; color: #4B5574; line-height: 1.7; margin-bottom: 25px; font-weight: 500; }
        .status-box { background: ${badgeBg}; color: ${badgeColor}; padding: 20px 25px; border-radius: 14px; font-size: 17px; font-weight: 800; text-align: center; box-shadow: 0 6px 20px rgba(0,0,0,0.1); margin-bottom: 30px; }
        .details-card { background: #F8FAFD; border: 1px solid #E2E8F4; border-radius: 16px; padding: 25px; margin-bottom: 30px; }
        .details-title { font-size: 16px; font-weight: 800; color: #070D24; margin-bottom: 15px; border-bottom: 2px solid #DCE3F0; padding-bottom: 10px; }
        .table { width: 100%; border-collapse: collapse; }
        .table td { padding: 12px 10px; font-size: 14px; border-bottom: 1px solid #EEF2F8; }
        .table td.label { font-weight: 700; color: #626D8A; width: 45%; }
        .table td.value { font-weight: 800; color: #070D24; }
        .score-display { font-size: 24px; font-weight: 900; color: ${isSuccess ? '#0FA99A' : '#E53E3E'}; }
        .subs-container { margin-top: 15px; padding-top: 15px; border-top: 1px dashed #DCE3F0; }
        .lockout-warning { background: #FFF9E6; border: 1px solid #F6E19E; color: #8F6B00; padding: 18px; border-radius: 12px; font-size: 13px; font-weight: 700; line-height: 1.6; margin-bottom: 30px; }
        .btn-container { text-align: center; margin: 35px 0 15px; }
        .btn { display: inline-block; padding: 15px 35px; background: #070D24; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 800; border-radius: 50px; box-shadow: 0 8px 25px rgba(7, 13, 36, 0.25); transition: transform 0.2s; }
        .footer { background: #F6F8FC; padding: 25px; text-align: center; font-size: 12px; color: #7A86A8; border-top: 1px solid #E4E8F2; line-height: 1.8; }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1>منصة وسيط AI · الاعتماد المهني</h1>
            <p>تقرير التدقيق الفوري ونتائج اختبار التخصص</p>
          </div>
          <div class="content">
            <div class="greeting">أهلاً بك، ${data.providerName || 'مقدم الخدمة المتميز'} 👋</div>
            
            <div class="intro-text">
              نحييك من إدارة الجدارة الفنية في وسيط AI. لقد انتهى للتو إجراءات الاختبار التمهيدي الفوري لتخصصك المهني المختار في المنصة، ونشاركك أدناه تفاصيل التقييم الذكي ونتيجة فحص الأصول والمراجعات الفنية.
            </div>
            
            <div class="status-box">
              ${statusLabel}
            </div>
            
            <div class="details-card">
              <div class="details-title">📊 بيانات ونتائج الجلسة الامتحانية</div>
              <table class="table">
                <tr>
                  <td class="label">التخصص الرئيسي المختار:</td>
                  <td class="value">${data.specialtyName}</td>
                </tr>
                <tr>
                  <td class="label">النتيجة النهائية (Score):</td>
                  <td class="value"><span class="score-display">${data.scorePercentage}%</span> (المطلوب للاعتماد أكثر من 25%)</td>
                </tr>
                <tr>
                  <td class="label">الإجابات الصحيحة:</td>
                  <td class="value">${data.correctAnswers} من أصل ${data.totalQuestions} سؤال فني</td>
                </tr>
                <tr>
                  <td class="label">حالة التوثيق بالشارة:</td>
                  <td class="value" style="color: ${isSuccess ? '#0FA99A' : '#E53E3E'}">${isSuccess ? '✓ تم تفعيل شارة التميز بملفك' : '🔒 غير مفعل (يتطلب إعادة الاختبار)'}</td>
                </tr>
                ${data.violationCount && data.violationCount > 0 ? `
                <tr>
                  <td class="label">مخالفات مراقبة المتصفح:</td>
                  <td class="value" style="color:#E53E3E;">${data.violationCount} تنبيهات مرصودة من نظام مكافحة الغش</td>
                </tr>
                ` : ''}
              </table>

              ${data.subSpecialties && data.subSpecialties.length > 0 ? `
              <div class="subs-container">
                <div style="font-size: 13px; font-weight: 700; color: #626D8A; margin-bottom: 8px;">التخصصات الفرعية المشغولة في الاختبار:</div>
                <div>${subSpecialtyBadges}</div>
              </div>
              ` : ''}
            </div>

            ${!isSuccess && data.lockoutUntil ? `
            <div class="lockout-warning">
              ⚠️ <strong>تنبيه بخصوص إعادة الاختبار:</strong><br>
              بناءً على معايير الحوكمة ومكافحة التلاعب في منصة وسيط AI، تم قفل إمكانية إيداع إجابات جديدة أو إعادة الاختبار لهذا التخصص لمدة <strong>24 ساعة</strong> (حتى ${new Date(data.lockoutUntil).toLocaleString('ar-SA')}). يمكنك الاستعداد جيداً والمحاولة بعد انقضاء المهلة.
            </div>
            ` : ''}

            ${isSuccess ? `
            <div style="font-size: 14px; color: #3E4968; font-weight: 600; line-height: 1.7;">
              ✨ شارة الاعتماد تمنحك أولوية الظهور في خوارزميات الذكاء الاصطناعي عند مطابقة طلبات العملاء، وتعزز جاذبية عروضك التجارية بنسبة تصل إلى 300%.
            </div>
            ` : ''}

            <div class="btn-container">
              <a href="https://waseet.ai/provider-overview/profile/specialties" class="btn">العودة إلى لوحة التخصصات في المنصة</a>
            </div>
          </div>
          <div class="footer">
            هذه رسالة إشعار تلقائية صادرة عن نظام الاختبارات ومكافحة التلاعب في <strong>وسيط AI</strong>.<br>
            &copy; ${new Date().getFullYear()} وسيط AI — جميع الحقوق محفوظة.
          </div>
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

  /**
   * Sends a high-fidelity notification email via Nodemailer containing the full Specialty Quiz Verification Results
   */
  public async sendSpecialtyQuizResultEmail(data: SpecialtyQuizResultEmailData): Promise<void> {
    try {
      const isSuccess = data.passed && !data.isInvalidated && !data.isTimedOut;
      const subject = isSuccess
        ? `🎉 مبروك! تم اعتماد تخصص (${data.specialtyName}) وتفعيل شارة التميز - وسيط AI`
        : `📋 نتيجة وتاريخ فحص التخصص (${data.specialtyName}) - وسيط AI`;

      const htmlContent = this.getSpecialtyQuizResultTemplate(data);

      if (!process.env.SMTP_USER && !process.env.SMTP_HOST) {
        logger.info(`[Nodemailer Simulation] Quiz Result Email prepared for ${data.email}. Subject: "${subject}". Score: ${data.scorePercentage}%, Passed: ${isSuccess}`);
        return;
      }

      const info = await this.transporter.sendMail({
        from: `"نظام الاعتماد المهني - وسيط AI" <${process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@waseet.ai'}>`,
        to: data.email,
        subject,
        html: htmlContent,
      });

      logger.info(`✅ Nodemailer: Specialty Quiz result email successfully dispatched to ${data.email} (MsgID: ${info?.messageId || 'simulated'})`);
    } catch (error) {
      logger.error(`❌ Nodemailer Error: Failed to send Specialty Quiz result email to ${data.email}:`, error);
      // Non-blocking catch to ensure database atomic consistency remains untouched by email provider downtime
    }
  }
}

export const emailService = new EmailService();
