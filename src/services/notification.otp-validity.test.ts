import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The mail must state the REAL validity of the code it carries. Payment codes (marketplace checkout, budget-increase authorization) live 2 minutes;
// every other code mail says 10. (A user reading "10 minutes" on a 2-minute code loses the code while still believing it is valid.)
process.env.OPENAI_API_KEY = 'test-key';

async function mailWith(t: any, send: (n: any) => Promise<void>) {
	const real = await import('../utils/mail.transporter');
	const sent: any[] = [];
	t.mock.module('../utils/mail.transporter', { namedExports: { ...real, mailTransporter: { sendMail: async (m: any) => { sent.push(m); await send(m); return { messageId: '<id>', accepted: [m.to], rejected: [], response: '250 ok' }; } } } });
	t.mock.module('../config/db', { namedExports: { prisma: {} } });
	t.mock.module('../socket', { namedExports: { getIO: () => null } });
	t.mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
	const { notificationService } = await import(`./notification.service.ts?v=${Math.random()}`);
	return { notificationService, sent };
}

test('payment code mail says 2 minutes (text and HTML), login / activation code mails say 10', async (t) => {
	const { notificationService, sent } = await mailWith(t, async () => {});
	await notificationService.sendPaymentOtpEmail('a@example.com', '123456');
	await notificationService.sendLoginOtpEmail('a@example.com', '654321');
	await notificationService.sendEmailOtp('a@example.com', '111111');
	const [pay, login, act] = sent;
	assert.match(pay.text, /صالح لمدة دقيقتين/); assert.match(pay.html, /صالح لمدة دقيقتين/); assert.doesNotMatch(pay.text + pay.html, /10 دقائق/);
	for (const m of [login, act]) { assert.match(m.text, /صالح لمدة 10 دقائق/); assert.match(m.html, /صالح لمدة 10 دقائق/); }
});

test('the 2 minutes the mail states equal the real TTL constants of both payment flows', () => {
	const cart = readFileSync('src/services/cart-checkout.service.ts', 'utf8');
	const amendment = readFileSync('src/services/project-amendment.service.ts', 'utf8');
	assert.equal((cart.match(/Date\.now\(\) \+ 2 \* 60 \* 1000/g) ?? []).length, 2, 'checkout: create and resend use 2 minutes');
	assert.match(amendment, /const PAYMENT_OTP_TTL_MS = 2 \* 60 \* 1000;/);
});

test('a mail the SMTP server rejects is reported as a failure and the log carries the duration, never the code', async (t) => {
	const lines: string[] = [];
	const real = await import('../utils/mail.transporter');
	t.mock.module('../utils/mail.transporter', { namedExports: { ...real, mailTransporter: { sendMail: async () => ({ messageId: '<id>', accepted: [], rejected: ['a@example.com'], response: '550 no' }) } } });
	t.mock.module('../config/db', { namedExports: { prisma: {} } });
	t.mock.module('../socket', { namedExports: { getIO: () => null } });
	t.mock.module('../config/logger', { namedExports: { logger: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m), debug() {} } } });
	const { notificationService } = await import(`./notification.service.ts?v=${Math.random()}`);
	await assert.rejects(() => notificationService.sendLoginOtpEmail('a@example.com', '987654'));
	assert.ok(lines.some(l => /\[Email:login\]/.test(l) && /ms=\d+/.test(l)));
	assert.ok(!lines.some(l => l.includes('987654')));
});
