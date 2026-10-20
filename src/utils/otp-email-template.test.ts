import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOtpEmailHtml, otpPurposeOfKind } from './otp-email-template';
import { getOtpEmailTemplate } from './mail.transporter';

const html = (code = '481296', minutes = 10, purpose: any = 'login') => buildOtpEmailHtml(code, minutes, purpose);

test('the code is ONE left-to-right text run in a nowrap box (copy/paste stays one number), no gradient text, no web font', () => {
	const h = html();
	assert.match(h, /class="ws-code" dir="ltr"[^>]*white-space:nowrap[^>]*>481296<\/div>/);
	assert.ok(!/<td[^>]*>\s*[0-9]\s*<\/td>/.test(h), 'digits are not split into cells');
	assert.ok(!/linear-gradient|background-clip|fonts\.googleapis/.test(h));
	assert.ok(!/<script/i.test(h));
});

test('narrow screens shrink the digits and their spacing (320 / 390 breakpoints) and the box never exceeds its container', () => {
	const h = html();
	assert.match(h, /max-width:400px[\s\S]*?\.ws-code\{font-size:22px/);
	assert.match(h, /max-width:340px[\s\S]*?\.ws-code\{font-size:19px/);
	assert.match(h, /max-width:240px/);
});

test('the validity line states the REAL validity passed in (10 min default, 2 min payment, 1 min)', () => {
	assert.match(html('123456', 10), /صالح لمدة 10 دقائق\. إذا لم تطلب هذا الرمز، تجاهل هذا البريد\./);
	assert.match(html('123456', 2, 'payment'), /صالح لمدة دقيقتين\./);
	assert.match(html('123456', 1), /صالح لمدة دقيقة واحدة\./);
});

test('every purpose keeps its own wording; login is the approved reference text', () => {
	assert.match(html('1', 10, 'login'), /رمز الدخول الخاص بك[\s\S]*أدخل الرمز التالي لإتمام تسجيل الدخول/);
	assert.match(html('1', 10, 'activation'), /رمز تفعيل حسابك/);
	assert.match(html('1', 2, 'payment'), /رمز تأكيد الدفع/);
	assert.match(html('1', 10, 'phone-change'), /تغيير رقم الجوال/);
	assert.match(html('1', 10, 'paypal-change'), /بريد PayPal/);
	assert.match(html('1', 10, 'contract-signature'), /توقيع العقد/);
	assert.equal(otpPurposeOfKind('login'), 'login');
	assert.equal(otpPurposeOfKind('otp'), 'activation');
	assert.equal(otpPurposeOfKind('payment'), 'payment');
	assert.equal(otpPurposeOfKind('phone-change'), 'phone-change');
	assert.equal(otpPurposeOfKind('paypal-email-change'), 'paypal-change');
	assert.equal(otpPurposeOfKind('whatever'), 'generic');
});

test('layout follows the reference: logo, WASEET AI, divider, title, subtitle, code box, validity, divider, copyright, help + unsubscribe links', () => {
	const prev = process.env.FRONTEND_URL; process.env.FRONTEND_URL = 'https://dev.example.test/';
	try {
		const h = html();
		const body = h.slice(h.indexOf('<body'));
		const order = ['waseet-mark.png', 'WASEET AI', 'رمز الدخول الخاص بك', 'أدخل الرمز التالي', 'class="ws-code"', 'صالح لمدة', 'جميع الحقوق محفوظة', 'مركز المساعدة', 'إلغاء الاشتراك'].map(s => body.indexOf(s));
		assert.ok(order.every(i => i > 0), 'all parts exist');
		assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the reference order');
		assert.match(h, /src="https:\/\/dev\.example\.test\/images\/waseet-mark\.png"[^>]*alt="Waseet AI"/);
		assert.match(h, /href="https:\/\/dev\.example\.test\/support\/help-center"/);
		assert.match(h, new RegExp(`© Waseet AI ${new Date().getFullYear()}|&copy; Waseet AI ${new Date().getFullYear()}`));
	} finally { if (prev === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = prev; }
});

test('the code and all dynamic text are escaped; the unsubscribe link can be configured', () => {
	const prev = process.env.EMAIL_UNSUBSCRIBE_URL; process.env.EMAIL_UNSUBSCRIBE_URL = 'https://x.test/u?a=1&b="2"';
	try {
		const h = html('<b>1</b>');
		assert.ok(!h.includes('<b>1</b>'));
		assert.match(h, /&lt;b&gt;1&lt;\/b&gt;/);
		assert.match(h, /href="https:\/\/x\.test\/u\?a=1&amp;b=&quot;2&quot;"/);
	} finally { if (prev === undefined) delete process.env.EMAIL_UNSUBSCRIBE_URL; else process.env.EMAIL_UNSUBSCRIBE_URL = prev; }
});

test('the exported mail.transporter template delegates to the same builder (old two-argument calls keep working)', () => {
	assert.equal(getOtpEmailTemplate('222222'), buildOtpEmailHtml('222222', 10, 'generic'));
	assert.equal(getOtpEmailTemplate('222222', 2, 'payment'), buildOtpEmailHtml('222222', 2, 'payment'));
});
