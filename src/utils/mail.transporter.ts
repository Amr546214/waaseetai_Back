import nodemailer from 'nodemailer';

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
export const mailTransporter = nodemailer.createTransport(smtpConfig);

// Waseet AI Verification Email Template
export const getOtpEmailTemplate = (code: string) => {
  return `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>رمز التحقق - وسيط AI</title>
      <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap" rel="stylesheet">
      <style>
        body {
          font-family: 'Tajawal', Tahoma, Arial, sans-serif;
          background-color: #070D24;
          color: #ffffff;
          margin: 0;
          padding: 0;
          -webkit-font-smoothing: antialiased;
        }
        .wrapper {
          padding: 40px 20px;
          background: #070D24;
        }
        .container {
          max-width: 520px;
          margin: 0 auto;
          background: #0B1437;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 24px;
          overflow: hidden;
        }
        .header {
          padding: 32px 32px 20px 32px;
          text-align: center;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .header h1 {
          margin: 0;
          background: linear-gradient(135deg, #2BD4C7, #2B7FFF);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          font-size: 26px;
          font-weight: 900;
          letter-spacing: -0.5px;
        }
        .content {
          padding: 32px;
          text-align: center;
        }
        .title {
          font-size: 20px;
          font-weight: 800;
          color: #ffffff;
          margin: 0 0 12px 0;
        }
        .desc {
          color: #A8B2D1;
          font-size: 15px;
          line-height: 1.6;
          margin: 0 0 32px 0;
        }
        .code-box {
          background: rgba(43, 212, 199, 0.08);
          border: 1px solid rgba(43, 212, 199, 0.25);
          border-radius: 16px;
          padding: 24px;
          margin: 0 auto 28px auto;
          font-size: 38px;
          font-weight: 900;
          letter-spacing: 12px;
          color: #2BD4C7;
          text-align: center;
          max-width: 320px;
          direction: ltr;
        }
        .warning {
          color: #6B7699;
          font-size: 13px;
          margin: 0;
          line-height: 1.5;
        }
        .footer {
          text-align: center;
          padding: 24px;
          color: #4A5568;
          font-size: 12px;
          background: rgba(0,0,0,0.15);
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1>Waseet AI</h1>
          </div>
          <div class="content">
            <h2 class="title">تأكيد الإجراء بكود OTP</h2>
            <p class="desc">أهلاً بك في وسيط AI.<br>يرجى استخدام رمز التحقق التالي لإتمام عمليتك بأمان:</p>
            
            <div class="code-box">
              ${code}
            </div>
            
            <p class="warning">هذا الرمز صالح لمدة 10 دقائق فقط.<br>يرجى عدم مشاركته مع أي شخص، فريق وسيط AI لن يطلب منك هذا الرمز أبداً.</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} وسيط الذكاء الاصطناعي للتقنية. جميع الحقوق محفوظة.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
};

// Waseet AI Password Reset Email Template
export const getPasswordResetEmailTemplate = (firstName: string, code: string) => {
  return `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>إعادة تعيين كلمة المرور - وسيط AI</title>
      <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap" rel="stylesheet">
      <style>
        body {
          font-family: 'Tajawal', Tahoma, Arial, sans-serif;
          background-color: #070D24;
          color: #ffffff;
          margin: 0;
          padding: 0;
          -webkit-font-smoothing: antialiased;
        }
        .wrapper {
          padding: 40px 20px;
          background: #070D24;
        }
        .container {
          max-width: 520px;
          margin: 0 auto;
          background: #0B1437;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 24px;
          overflow: hidden;
        }
        .header {
          padding: 32px 32px 20px 32px;
          text-align: center;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .header h1 {
          margin: 0;
          background: linear-gradient(135deg, #2BD4C7, #2B7FFF);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          font-size: 26px;
          font-weight: 900;
          letter-spacing: -0.5px;
        }
        .content {
          padding: 32px;
          text-align: center;
        }
        .title {
          font-size: 20px;
          font-weight: 800;
          color: #ffffff;
          margin: 0 0 12px 0;
        }
        .desc {
          color: #A8B2D1;
          font-size: 15px;
          line-height: 1.6;
          margin: 0 0 32px 0;
        }
        .code-box {
          background: rgba(43, 212, 199, 0.08);
          border: 1px solid rgba(43, 212, 199, 0.25);
          border-radius: 16px;
          padding: 24px;
          margin: 0 auto 28px auto;
          font-size: 38px;
          font-weight: 900;
          letter-spacing: 12px;
          color: #2BD4C7;
          text-align: center;
          max-width: 320px;
          direction: ltr;
        }
        .warning {
          color: #6B7699;
          font-size: 13px;
          margin: 0;
          line-height: 1.5;
        }
        .footer {
          text-align: center;
          padding: 24px;
          color: #4A5568;
          font-size: 12px;
          background: rgba(0,0,0,0.15);
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1>Waseet AI</h1>
          </div>
          <div class="content">
            <h2 class="title">طلب إعادة تعيين كلمة المرور</h2>
            <p class="desc">أهلاً ${firstName || ''}،<br>وصلنا طلب لإعادة تعيين كلمة المرور الخاصة بحسابك في منصة وسيط AI. استخدم الرمز التالي لمتابعة العملية:</p>

            <div class="code-box">
              ${code}
            </div>

            <p class="warning">هذا الرمز صالح لمدة 10 دقائق فقط.<br>إذا لم تطلب إعادة تعيين كلمة المرور، يمكنك تجاهل هذه الرسالة بأمان ولن يتم تغيير أي شيء في حسابك.</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} وسيط الذكاء الاصطناعي للتقنية. جميع الحقوق محفوظة.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
};

// Waseet AI Escrow Deposit Confirmation Template
export const getDepositConfirmationTemplate = (projectName: string, amount: number) => {
  return `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>تأكيد إيداع الضمان - وسيط AI</title>
      <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap" rel="stylesheet">
      <style>
        body {
          font-family: 'Tajawal', Tahoma, Arial, sans-serif;
          background-color: #070D24;
          color: #ffffff;
          margin: 0;
          padding: 0;
          -webkit-font-smoothing: antialiased;
        }
        .wrapper {
          padding: 40px 20px;
          background: #070D24;
        }
        .container {
          max-width: 520px;
          margin: 0 auto;
          background: #0B1437;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 24px;
          overflow: hidden;
        }
        .header {
          padding: 32px 32px 20px 32px;
          text-align: center;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .header h1 {
          margin: 0;
          background: linear-gradient(135deg, #2BD4C7, #2B7FFF);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          font-size: 26px;
          font-weight: 900;
          letter-spacing: -0.5px;
        }
        .content {
          padding: 32px;
          text-align: center;
        }
        .title {
          font-size: 20px;
          font-weight: 800;
          color: #ffffff;
          margin: 0 0 12px 0;
        }
        .desc {
          color: #A8B2D1;
          font-size: 15px;
          line-height: 1.6;
          margin: 0 0 32px 0;
        }
        .info-box {
          background: rgba(43, 212, 199, 0.08);
          border: 1px solid rgba(43, 212, 199, 0.25);
          border-radius: 16px;
          padding: 24px;
          margin: 0 auto 28px auto;
          text-align: center;
          max-width: 380px;
        }
        .info-box h3 {
          color: #2BD4C7;
          margin: 0 0 8px 0;
          font-size: 24px;
          font-weight: 800;
        }
        .info-box p {
          color: #ffffff;
          margin: 0;
          font-size: 16px;
          font-weight: 500;
        }
        .footer {
          text-align: center;
          padding: 24px;
          color: #4A5568;
          font-size: 12px;
          background: rgba(0,0,0,0.15);
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1>Waseet AI</h1>
          </div>
          <div class="content">
            <h2 class="title">تم إيداع الضمان بنجاح 🎉</h2>
            <p class="desc">أهلاً بك،<br>تم تأكيد استلام الدفعة وإيداعها في حساب الضمان الآمن الخاص بمنصة وسيط الذكاء الاصطناعي للمشروع التالي:</p>
            
            <div class="info-box">
              <h3>${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $</h3>
              <p>مشروع: ${projectName}</p>
            </div>
            
            <p class="desc">تم تغيير حالة المشروع إلى "قيد التنفيذ". سيبقى المبلغ آمناً لدينا ولن يتم تحويله لمقدم الخدمة إلا بعد استلامك للمشروع واعتمادك النهائي له.</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} وسيط الذكاء الاصطناعي للتقنية. جميع الحقوق محفوظة.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
};

// Waseet AI Provider Contract Signature Template
export const getProviderContractSignatureTemplate = (projectName: string, clientName: string, amount: number) => {
  return `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>توقيع عقد مشروع جديد - وسيط AI</title>
      <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap" rel="stylesheet">
      <style>
        body {
          font-family: 'Tajawal', Tahoma, Arial, sans-serif;
          background-color: #070D24;
          color: #ffffff;
          margin: 0;
          padding: 0;
          -webkit-font-smoothing: antialiased;
        }
        .wrapper {
          padding: 40px 20px;
          background: #070D24;
        }
        .container {
          max-width: 520px;
          margin: 0 auto;
          background: #0B1437;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 24px;
          overflow: hidden;
        }
        .header {
          padding: 32px 32px 20px 32px;
          text-align: center;
          border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .header h1 {
          margin: 0;
          background: linear-gradient(135deg, #2BD4C7, #2B7FFF);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          font-size: 26px;
          font-weight: 900;
          letter-spacing: -0.5px;
        }
        .content {
          padding: 32px;
          text-align: center;
        }
        .title {
          font-size: 20px;
          font-weight: 800;
          color: #ffffff;
          margin: 0 0 12px 0;
        }
        .desc {
          color: #A8B2D1;
          font-size: 15px;
          line-height: 1.6;
          margin: 0 0 32px 0;
        }
        .info-box {
          background: rgba(43, 127, 255, 0.08);
          border: 1px solid rgba(43, 127, 255, 0.25);
          border-radius: 16px;
          padding: 24px;
          margin: 0 auto 28px auto;
          text-align: center;
          max-width: 380px;
        }
        .info-box h3 {
          color: #2B7FFF;
          margin: 0 0 8px 0;
          font-size: 24px;
          font-weight: 800;
        }
        .info-box p {
          color: #ffffff;
          margin: 0;
          font-size: 16px;
          font-weight: 500;
        }
        .footer {
          text-align: center;
          padding: 24px;
          color: #4A5568;
          font-size: 12px;
          background: rgba(0,0,0,0.15);
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <h1>Waseet AI</h1>
          </div>
          <div class="content">
            <h2 class="title">دعوة لتوقيع العقد 📝</h2>
            <p class="desc">أهلاً بك،<br>لقد تم قبول عرضك وإيداع قيمة المشروع في حساب الضمان الآمن الخاص بمنصة وسيط الذكاء الاصطناعي.</p>
            
            <div class="info-box">
              <h3>${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $</h3>
              <p>مشروع: ${projectName}</p>
            </div>
            
            <p class="desc">يرجى الدخول إلى حسابك في المنصة وتوقيع العقد للبدء في تنفيذ المشروع.<br>تم تغيير حالة المشروع إلى "قيد التنفيذ". نتمنى لك التوفيق!</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} وسيط الذكاء الاصطناعي للتقنية. جميع الحقوق محفوظة.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
};
