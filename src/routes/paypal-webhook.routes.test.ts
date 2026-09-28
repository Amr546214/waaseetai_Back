import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static-source regression guard: the PayPal webhook route must stay public
// (PayPal cannot present a WaseetAI JWT) — confirms no authenticate/
// requireActiveUser middleware is wired into this router.

const source = fs.readFileSync(path.join(__dirname, 'paypal-webhook.routes.ts'), 'utf8');

test('paypal-webhook router does not apply authenticate/requireActiveUser', () => {
	assert.doesNotMatch(source, /authenticate/);
	assert.doesNotMatch(source, /requireActiveUser/);
	assert.match(source, /router\.post\('\/webhook',\s*handlePaypalWebhook\)/);
});
