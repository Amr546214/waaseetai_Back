import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotificationEmailHtml } from './notification-email-template';

const base = { lang: 'ar' as const, greeting: 'أهلاً سارة', title: 'فرصة مشروع جديدة: تطوير موقع <b>x</b>', message: 'تم نشر طلب جديد يتوافق مع تخصصك. قدم عرضك الآن!', ctaLabel: 'عرض التفاصيل وتقديم عرض', footerNote: 'وصلتك هذه الرسالة لأنك اخترت البريد كقناة إشعارات في إعداداتك.' };
const withSite = (fn: () => void) => { const p = process.env.FRONTEND_URL; process.env.FRONTEND_URL = 'https://dev.waseetai.com'; try { fn(); } finally { if (p === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = p; } };

test('centered card on the shared shell: greeting, title, message, ONE solid button with an absolute link, footer note', () => withSite(() => {
	const h = buildNotificationEmailHtml({ ...base, linkUrl: 'https://dev.waseetai.com/provider-overview/explore-requests/1/apply' });
	const body = h.slice(h.indexOf('<body'));
	const order = ['waseet-mark.png', 'WASEET AI', 'أهلاً سارة', 'فرصة مشروع جديدة', 'تم نشر طلب جديد', 'عرض التفاصيل وتقديم عرض', 'وصلتك هذه الرسالة', 'جميع الحقوق محفوظة', 'مركز المساعدة'].map(s => body.indexOf(s));
	assert.ok(order.every(i => i > 0));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
	assert.match(h, /<td align="center" bgcolor="#1c6fdc"[^>]*><a href="https:\/\/dev\.waseetai\.com\/provider-overview\/explore-requests\/1\/apply"[^>]*>عرض التفاصيل وتقديم عرض<\/a>/);
	assert.match(h, /max-width:600px/);
	assert.match(h, /name="viewport"/);
	assert.ok(!/<script|linear-gradient|fonts\.googleapis/.test(h));
}));

test('title and message are escaped', () => withSite(() => {
	const h = buildNotificationEmailHtml({ ...base, linkUrl: null });
	assert.ok(!h.includes('<b>x</b>'));
	assert.match(h, /&lt;b&gt;x&lt;\/b&gt;/);
}));

test('no link -> no button (never a host-less one)', () => withSite(() => {
	const h = buildNotificationEmailHtml({ ...base, linkUrl: null });
	assert.ok(!h.includes('bgcolor="#1c6fdc"'));
	assert.ok(!/href="\/|href=""/.test(h));
}));

test('english: ltr + english footer wording', () => withSite(() => {
	const h = buildNotificationEmailHtml({ ...base, lang: 'en', greeting: 'Hello Sara', ctaLabel: 'Open', linkUrl: 'https://dev.waseetai.com/x' });
	assert.match(h, /<html lang="en" dir="ltr">/);
	assert.match(h, />Open</);
	assert.match(h, /Help center/);
	assert.match(h, /All rights reserved/);
}));
