import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
process.env.FRONTEND_URL = 'https://dev.example.test';

/**
 * Static guards of the mail policy (EMAIL-AUDIT-2026-10-26.md, Round 2): ONE shared shell/identity for every template, the class table, the pairing table, the sender paths.
 */
const SRC = path.join(__dirname, '..');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name) ? [path.join(d, e.name)] : []);
const files = walk(SRC);
const read = (f: string) => fs.readFileSync(f, 'utf8');

test('every .sendMail( call site is a known, reviewed mail path (a new one must be classified in mail-dispatch first)', () => {
	const sites = files.filter(f => /\.sendMail\(/.test(read(f))).map(f => path.relative(SRC, f)).sort();
	assert.deepEqual(sites, [
		'services/admin-mailbox-alert.service.ts', // SYSTEM
		'services/chat-digest.service.ts', // OPTIONAL (own claim)
		'services/client-requests.service.ts', // contract-signature code (AUTH)
		'services/email.service.ts', // activation code (AUTH, dead), model audit (OPTIONAL, dead)
		'services/mail-dispatch.ts', // the central sender (TRANSACTIONAL / OPTIONAL event mails)
		'services/notification.service.ts', // codes (AUTH) + reset
	]);
});

test('no mail source ships an external web font, a stylesheet link, a gradient background or a hard-coded brand / sender', () => {
	for (const f of ['utils/mail.transporter.ts', 'utils/otp-email-template.ts', 'utils/notification-email-template.ts', 'utils/email-shell.ts', 'services/email.service.ts', 'services/mail-dispatch.ts']) {
		const s = read(path.join(SRC, f));
		assert.doesNotMatch(s, /fonts\.googleapis|<link |linear-gradient|background-clip/, f);
		assert.doesNotMatch(s, /waseet\.ai|no-reply@/, f);
		assert.doesNotMatch(s, /<h1|<style[^>]*>[^<]*body\s*\{/, f);
	}
});

test('every full-page mail template is built by renderEmailShell (one identity)', () => {
	const t = read(path.join(SRC, 'utils/mail.transporter.ts'));
	assert.equal((t.match(/renderEmailShell\(/g) ?? []).length, 3, 'reset + receipt + invitation');
	assert.doesNotMatch(t, /<!DOCTYPE/i);
	for (const f of ['utils/otp-email-template.ts', 'utils/notification-email-template.ts', 'services/email.service.ts']) assert.match(read(path.join(SRC, f)), /renderEmailShell\(/, f);
	assert.doesNotMatch(read(path.join(SRC, 'services/email.service.ts')), /<!DOCTYPE|createTransport/i);
});

test('classes: AUTH codes, TRANSACTIONAL receipt + invitation, OPTIONAL copies/digest/reward/model; every covered notification points to an existing non-AUTH purpose', async () => {
	const { MAIL_PURPOSES, COVERED_NOTIFICATIONS, mailClassOf, coveringMailOf } = await import('../services/mail-dispatch');
	assert.equal(mailClassOf('escrow-deposit-receipt'), 'TRANSACTIONAL'); assert.equal(mailClassOf('provider-contract-invitation'), 'TRANSACTIONAL');
	for (const k of ['login-code', 'activation-code', 'password-reset-code', 'payment-code', 'contract-signature-code', 'phone-change-code', 'paypal-change-code', 'admin-invite-code'] as const) assert.equal(mailClassOf(k), 'AUTH', k);
	for (const k of ['notification-copy', 'chat-digest', 'project-completion-reward', 'model-audit-result'] as const) assert.equal(mailClassOf(k), 'OPTIONAL', k);
	for (const [type, purpose] of Object.entries(COVERED_NOTIFICATIONS)) { assert.ok(purpose in MAIL_PURPOSES, type); assert.notEqual(mailClassOf(purpose), 'AUTH'); }
	assert.equal(coveringMailOf('ESCROW_FUNDED'), 'escrow-deposit-receipt'); assert.equal(coveringMailOf('OFFER_ACCEPTED'), 'provider-contract-invitation'); assert.equal(coveringMailOf('PROJECT_COMPLETION_REWARD'), 'project-completion-reward');
	assert.equal(coveringMailOf('GENERAL'), null); assert.equal(coveringMailOf('CHAT'), null);
});

test('each covered notification type still has exactly one producer (so the suppression cannot silence a mail that has no dedicated twin)', () => {
	const count = (type: string) => files.filter(f => !/mail-dispatch\.ts$|notification-email-template/.test(f)).reduce((n, f) => n + (read(f).match(new RegExp(`type: '${type}'`, 'g')) ?? []).length, 0);
	assert.equal(count('ESCROW_FUNDED'), 1); assert.equal(count('OFFER_ACCEPTED'), 1);
	// PROJECT_COMPLETION_REWARD is a conditional expression in project-progress (next to STAGE_REVIEW)
	assert.equal(files.filter(f => /'PROJECT_COMPLETION_REWARD'/.test(read(f)) && !/mail-dispatch/.test(f)).length, 1);
});

test('all templates render on the shared shell: RTL, 600px card, brand from settings, escaped user text, no external resources, no raw placeholders', async () => {
	const { getPasswordResetEmailTemplate, getDepositConfirmationTemplate, getProviderContractSignatureTemplate, getOtpEmailTemplate } = await import('./mail.transporter');
	const { buildNotificationEmailHtml } = await import('./notification-email-template');
	const { setBrandName } = await import('./brand');
	const evil = '<script>alert(1)</script>"x"';
	setBrandName('منصة الاختبار');
	try {
		const pages = {
			reset: getPasswordResetEmailTemplate(evil, '123456', 10),
			deposit: getDepositConfirmationTemplate(evil, 1250.5, 'https://dev.example.test/client-overview/projects/active'),
			invite: getProviderContractSignatureTemplate(evil, evil, 1250.5, 'https://dev.example.test/provider-overview/offers/o/sign-contract'),
			otp: getOtpEmailTemplate('123456', 10, 'login'),
			note: buildNotificationEmailHtml({ lang: 'ar', greeting: 'أهلاً', title: evil, message: evil, linkUrl: 'https://dev.example.test/x', ctaLabel: 'فتح', footerNote: 'f' }),
		};
		for (const [name, h] of Object.entries(pages)) {
			assert.match(h, /<html lang="ar" dir="rtl">/, name); assert.match(h, /max-width:600px/, name); assert.match(h, /<meta name="color-scheme" content="light only">/, name);
			assert.doesNotMatch(h, /<script|fonts\.googleapis|<link |undefined|\[object|\{\{/, name);
			assert.match(h, /منصة الاختبار|MANSAT/i, name); assert.doesNotMatch(h, /Waseet AI|وسيط AI/, name);
		}
		assert.match(pages.reset, /123456/); assert.match(pages.reset, /لا تشاركه مع أي أحد/); assert.match(pages.reset, /صالح لمدة 10 دقائق/); assert.match(pages.otp, /لا تشاركه مع أي أحد/);
		assert.match(pages.deposit, /1,250\.50 \$/); assert.match(pages.invite, /1,250\.50 \$/);
		assert.match(pages.deposit, /تصلك دائمًا/); assert.match(pages.invite, /تصلك دائمًا/);
		assert.match(pages.invite, /sign-contract/); assert.match(pages.deposit, /client-overview/);
		assert.match(pages.deposit, /dir="ltr"/, 'the amount is an isolated LTR run');
	} finally { setBrandName(''); }
});
