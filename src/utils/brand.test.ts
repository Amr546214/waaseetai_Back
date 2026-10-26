import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandName, brandNameInArabicText, brandSubject, setBrandName, DEFAULT_BRAND } from './brand';
import { renderEmailShell } from './email-shell';
import { buildNotificationEmailHtml } from './notification-email-template';
import { getOtpEmailTemplate } from './mail.transporter';

test('platform name in NEW e-mails: default unchanged, configured name replaces header / footer / title / default subjects; an env-overridden subject is left alone', () => {
	setBrandName(''); assert.equal(brandName(), DEFAULT_BRAND);
	const base = buildNotificationEmailHtml({ lang: 'ar', greeting: 'g', title: 'عنوان', message: 'm', linkUrl: null, ctaLabel: 'فتح', footerNote: 'f' } as any);
	assert.match(base, /WASEET AI/); assert.match(base, /&copy; Waseet AI /); assert.match(base, /<title>عنوان - Waseet AI<\/title>/);
	setBrandName('  أكمي AI  '); const html = buildNotificationEmailHtml({ lang: 'ar', greeting: 'g', title: 'عنوان', message: 'm', linkUrl: null, ctaLabel: 'فتح', footerNote: 'f' } as any);
	assert.ok(html.includes('&copy; أكمي AI ') && html.includes('<title>عنوان - أكمي AI</title>') && !html.includes('Waseet AI'), 'no stale built-in name');
	assert.equal(brandSubject('رمز تسجيل الدخول - Waseet AI'), 'رمز تسجيل الدخول - أكمي AI'); assert.equal(brandSubject('Custom subject from env'), 'Custom subject from env'); assert.equal(brandNameInArabicText(), 'أكمي AI');
	setBrandName('<script>x</script>'); assert.ok(!renderEmailShell({ lang: 'ar', docTitle: 't', bodyHtml: '' } as any).includes('<script>x'), 'the name is escaped in HTML');
	setBrandName(''); assert.equal(brandNameInArabicText(), 'وسيط AI'); assert.ok(typeof getOtpEmailTemplate === 'function');
});

test('the deposit, contract-signature and password-reset mails carry the configured platform name (not a fixed brand), with the record\'s currency', async () => {
	const { setBrandName } = await import('./brand'); const t = await import('./mail.transporter');
	setBrandName('منصة اختبار');
	try {
		const dep = t.getDepositConfirmationTemplate('مشروع', 100, 'SAR'); const sig = t.getProviderContractSignatureTemplate('مشروع', 'عميل', 250.5, 'USD'); const reset = t.getPasswordResetEmailTemplate?.('1234', 'اسم') ?? '';
		for (const html of [dep, sig, reset].filter(Boolean)) { assert.match(html, /منصة اختبار/); assert.doesNotMatch(html, /Waseet AI|وسيط الذكاء الاصطناعي للتقنية/); }
		assert.match(dep, /100\.00 SAR/); assert.match(sig, /250\.50 USD/); assert.doesNotMatch(dep, /100\.00 \$/);
	} finally { setBrandName(''); }
});
