import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getPasswordResetEmailTemplate, getDepositConfirmationTemplate, getProviderContractSignatureTemplate } from './mail.transporter';

// Audit 2026-10-26: user-controlled text (first name, project title) was put into the HTML of these mails unescaped.
test('password-reset mail escapes the first name', () => {
	const html = getPasswordResetEmailTemplate('<img src=x onerror=alert(1)>', '123456', 10);
	assert.doesNotMatch(html, /<img src=x/); assert.match(html, /&lt;img src=x/);
});
test('deposit + contract mails escape the project title', () => {
	for (const html of [getDepositConfirmationTemplate('<script>alert(1)</script>', 100), getProviderContractSignatureTemplate('<script>alert(1)</script>', 'x', 100)]) {
		assert.doesNotMatch(html, /<script>alert/); assert.match(html, /&lt;script&gt;/);
	}
});
test('no mail path builds its own From: contract / deposit mails use the shared sender (SMTP_FROM + platform name), never SMTP_USER', () => {
	const src = fs.readFileSync(path.join(__dirname, '../services/client-requests.service.ts'), 'utf8');
	assert.doesNotMatch(src, /from: process\.env\.SMTP_USER/);
	assert.equal((src.match(/from: await transactionalFrom\(\)/g) ?? []).length, 3);
});
test('the chat digest mail uses the shared branded shell (logo / brand / button), not an ad-hoc div', () => {
	const src = fs.readFileSync(path.join(__dirname, '../services/chat-digest.service.ts'), 'utf8');
	assert.match(src, /buildNotificationEmailHtml\(/); assert.doesNotMatch(src, /<div dir=/);
});
test('the reward mail has no hard-coded brand or sender', () => {
	const src = fs.readFileSync(path.join(__dirname, '../services/email.service.ts'), 'utf8');
	const block = src.slice(src.indexOf('sendProjectCompletionRewardEmail(data'));
	assert.doesNotMatch(block, /وسيط AI|waseet\.ai/);
});
