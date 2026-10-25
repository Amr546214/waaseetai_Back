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
