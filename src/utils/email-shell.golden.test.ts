import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * GOLDEN: the generated HTML of every template that uses the e-mail shell, in the DEFAULT identity state, is byte-identical to what the code produced BEFORE the logo.email wiring
 * (fixtures captured from the pre-change code with GENERATE_EMAIL_GOLDEN=1). The shell asks the identity cache for the logo; with nothing custom it must emit exactly the old markup.
 */
const FIX = path.join(__dirname, '..', 'testing', 'fixtures', 'email-golden', 'golden.json');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function renderAll(): Promise<Record<string, string>> {
	const shell = await import('./email-shell'); const otp = await import('./otp-email-template'); const note = await import('./notification-email-template'); const tx = await import('./mail.transporter');
	const out: Record<string, string> = {};
	for (const lang of ['ar', 'en'] as const) {
		out[`shell-${lang}-plain`] = shell.renderEmailShell({ lang, docTitle: 'عنوان', bodyHtml: '<p>body</p>' });
		out[`shell-${lang}-footer-pad`] = shell.renderEmailShell({ lang, docTitle: 'T', bodyHtml: '<p>x</p>', footerNote: 'note', padStyle: 'padding:1px;' });
		out[`notification-${lang}-link`] = note.buildNotificationEmailHtml({ lang, greeting: 'مرحبا', title: 'عنوان', message: 'رسالة\nسطر', linkUrl: 'https://front.test/x', ctaLabel: 'فتح', footerNote: 'f' });
		out[`notification-${lang}-nolink`] = note.buildNotificationEmailHtml({ lang, greeting: '', title: 'T', message: 'm', linkUrl: null, ctaLabel: 'c', footerNote: '' });
	}
	for (const p of ['login', 'activation', 'payment', 'phone-change', 'paypal-change', 'contract-signature', 'admin-invite', 'generic'] as const) out[`otp-${p}`] = otp.buildOtpEmailHtml('123456', 10, p);
	out['reset'] = tx.getPasswordResetEmailTemplate('أحمد', '654321', 10);
	out['deposit'] = tx.getDepositConfirmationTemplate('مشروع', 1250, 'https://front.test/p');
	out['signature'] = tx.getProviderContractSignatureTemplate('مشروع', 'عميل', 99.5, null);
	return out;
}

async function renderAllVariants() {
	const res: Record<string, string> = {};
	for (const [label, front, asset] of [['front', 'https://front.test', ''], ['assetbase', 'https://front.test', 'https://cdn.test/'], ['nofront', '', '']] as const) {
		if (front) process.env.FRONTEND_URL = front; else delete process.env.FRONTEND_URL;
		if (asset) process.env.EMAIL_ASSET_BASE_URL = asset; else delete process.env.EMAIL_ASSET_BASE_URL;
		for (const [k, v] of Object.entries(await renderAll())) res[`${label}/${k}`] = v;
	}
	delete process.env.EMAIL_ASSET_BASE_URL; process.env.FRONTEND_URL = 'https://front.test';
	return res;
}

test('golden: every shell template renders byte-identically to the pre-wiring code in the default identity state', async () => {
	mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-15T12:00:00Z') });
	try {
		const now = await renderAllVariants();
		if (process.env.GENERATE_EMAIL_GOLDEN === '1') { fs.writeFileSync(FIX, JSON.stringify(Object.fromEntries(Object.entries(now).map(([k, v]) => [k, { sha256: sha(v), html: v }])), null, 1)); return; }
		const gold = JSON.parse(fs.readFileSync(FIX, 'utf8')) as Record<string, { sha256: string; html: string }>;
		assert.deepEqual(Object.keys(now).sort(), Object.keys(gold).sort());
		assert.ok(Object.keys(now).length >= 60, `variants: ${Object.keys(now).length}`);
		for (const [k, v] of Object.entries(now)) { assert.equal(v, gold[k].html, `byte-identical: ${k}`); assert.equal(sha(v), gold[k].sha256); }
		assert.ok(now['front/reset'].includes('https://front.test/images/waseet-mark.png'), 'the default logo URL is the long-standing one');
	} finally { mock.timers.reset(); }
});
