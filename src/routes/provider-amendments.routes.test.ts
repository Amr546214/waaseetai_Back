import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The suite does not boot Express: route wiring is proven statically (same approach as the other routes tests).
const source = fs.readFileSync(path.join(__dirname, 'provider.routes.ts'), 'utf8');

test('GET and POST /projects/:projectId/amendments are wired for providers only: authenticate + requireActiveUser + providerOnly', () => {
	assert.match(source, /router\.get\('\/projects\/:projectId\/amendments',\s*authenticate,\s*requireActiveUser,\s*providerOnly,\s*providerProjectAmendmentsController\.list\)/);
	assert.match(source, /router\.post\('\/projects\/:projectId\/amendments',\s*authenticate,\s*requireActiveUser,\s*providerOnly,\s*providerProjectAmendmentsController\.create\)/);
});

test('the controller never reads the provider id from the request body or params (only the authenticated user)', () => {
	const controller = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'provider-project-amendments.controller.ts'), 'utf8');
	assert.match(controller, /req\.user!\.userId \|\| req\.user!\.id/);
	assert.doesNotMatch(controller, /req\.body\??\.(providerId|userId|clientId|requestedBy)/);
	assert.doesNotMatch(controller, /req\.params\.(providerId|userId)/);
});

test('the client\'s own amendment routes are unchanged', () => {
	const client = fs.readFileSync(path.join(__dirname, 'client-project-amendments.routes.ts'), 'utf8');
	assert.match(client, /router\.get\('\/amendments', clientOnly, clientProjectAmendmentsController\.listAmendments\)/);
	assert.match(client, /router\.post\('\/amendments\/:id\/respond', clientOnly, clientProjectAmendmentsController\.respondToAmendment\)/);
	assert.match(client, /router\.post\('\/:projectId\/amendments', clientOnly, clientProjectAmendmentsController\.createAmendment\)/);
});

test('amendment-effective routes: client payment-otp / authorize-funding / cancel are client-role gated; the provider cancel is provider-only; the OTP code travels only in the body', () => {
	const client = fs.readFileSync(path.join(__dirname, 'client-project-amendments.routes.ts'), 'utf8');
	assert.match(client, /const clientOnly = authorizeActiveRole\(AccountType\.CLIENT_INDIVIDUAL, AccountType\.CLIENT_COMPANY\)/);
	assert.match(client, /router\.post\('\/amendments\/:id\/payment-otp', clientOnly, paymentLimiter, clientProjectAmendmentsController\.initPaymentAuthorization\)/);
	assert.match(client, /router\.post\('\/amendments\/:id\/authorize-funding', clientOnly, paymentLimiter, clientProjectAmendmentsController\.authorizeFunding\)/);
	assert.match(client, /router\.post\('\/amendments\/:id\/cancel', clientOnly, clientProjectAmendmentsController\.cancelAmendment\)/);
	assert.match(source, /router\.post\('\/amendments\/:id\/cancel',\s*authenticate,\s*requireActiveUser,\s*providerOnly,\s*providerProjectAmendmentsController\.cancel\)/);
	const controller = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'client-project-amendments.controller.ts'), 'utf8');
	assert.match(controller, /respondToAmendment\(userId, req\.params\.id as string, req\.body\?\.decision, req\.body\?\.otpCode\)/);
	assert.doesNotMatch(controller, /req\.(query|params)\??\.otp/);
});
