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

test('the digits fit 320px WITHOUT any media query: fixed 240px box, 22px digits, 4px spacing inline (a mail app that drops <style> still shows one line)', () => {
	const h = html();
	assert.match(h, /<table[^>]*width="240"[^>]*style="width:240px/);
	assert.match(h, /class="ws-code"[^>]*font-size:22px;[^"]*letter-spacing:4px/);
	assert.ok(!/class="ws-code"[^>]*(?:font-size|letter-spacing):[^;"]*(?:vw|em|clamp)/.test(h));
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

test('layout follows the reference: logo, WASEET AI, divider, title, subtitle, code box, validity, divider, copyright, and ONE help link (no unsubscribe: it has no function)', () => {
	const prev = process.env.FRONTEND_URL; process.env.FRONTEND_URL = 'https://dev.example.test/';
	try {
		const h = html();
		const body = h.slice(h.indexOf('<body'));
		const order = ['waseet-mark.png', 'WASEET AI', 'رمز الدخول الخاص بك', 'أدخل الرمز التالي', 'class="ws-code"', 'صالح لمدة', 'جميع الحقوق محفوظة', 'مركز المساعدة'].map(s => body.indexOf(s));
		assert.ok(order.every(i => i > 0), 'all parts exist');
		assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the reference order');
		assert.match(h, /src="https:\/\/dev\.example\.test\/images\/waseet-mark\.png"[^>]*alt="Waseet AI"/);
		assert.match(h, /href="https:\/\/dev\.example\.test\/support\/help-center"/);
		assert.ok(!h.includes('إلغاء الاشتراك'), 'no unsubscribe link');
		assert.ok(!/unsubscribe/i.test(h));
		assert.match(h, new RegExp(`© Waseet AI ${new Date().getFullYear()}|&copy; Waseet AI ${new Date().getFullYear()}`));
	} finally { if (prev === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = prev; }
});

test('the code is escaped', () => {
	const h = html('<b>1</b>');
	assert.ok(!h.includes('<b>1</b>'));
	assert.match(h, /&lt;b&gt;1&lt;\/b&gt;/);
});

test('the exported mail.transporter template delegates to the same builder (old two-argument calls keep working)', () => {
	assert.equal(getOtpEmailTemplate('222222'), buildOtpEmailHtml('222222', 10, 'generic'));
	assert.equal(getOtpEmailTemplate('222222', 2, 'payment'), buildOtpEmailHtml('222222', 2, 'payment'));
});

test('image host and link host are independent; with no configured site nothing host-less is ever emitted (logo and help link are left out)', () => {
	const f = process.env.FRONTEND_URL, a = process.env.EMAIL_ASSET_BASE_URL;
	const restore = () => { if (f === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = f; if (a === undefined) delete process.env.EMAIL_ASSET_BASE_URL; else process.env.EMAIL_ASSET_BASE_URL = a; };
	try {
		process.env.FRONTEND_URL = 'https://app.example.test'; process.env.EMAIL_ASSET_BASE_URL = 'https://cdn.example.test/';
		let h = html();
		assert.match(h, /src="https:\/\/cdn\.example\.test\/images\/waseet-mark\.png"/);
		assert.match(h, /href="https:\/\/app\.example\.test\/support\/help-center"/);
		delete process.env.EMAIL_ASSET_BASE_URL;
		h = html();
		assert.match(h, /src="https:\/\/app\.example\.test\/images\/waseet-mark\.png"/);
		delete process.env.FRONTEND_URL;
		h = html();
		assert.ok(!/<img/.test(h) && !/<a /.test(h), 'no logo, no link without a configured site');
		process.env.FRONTEND_URL = 'not a url'; process.env.EMAIL_ASSET_BASE_URL = '/relative';
		h = html();
		assert.ok(!/<img/.test(h) && !/<a /.test(h));
		assert.ok(!/href="\/|src="\//.test(h), 'never a host-less URL');
		assert.ok(!h.includes('waseet.ai/'));
	} finally { restore(); }
});
