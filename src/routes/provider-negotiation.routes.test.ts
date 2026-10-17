import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The negotiation routes sit behind authenticate + requireActiveUser + providerOnly (token role, never a body field).
const src = readFileSync(new URL('./provider.routes.ts', import.meta.url), 'utf8');
for (const [method, path, handler] of [
	['get', '/offers/:id/negotiation', 'viewByOffer'], ['get', '/projects/:projectId/negotiation', 'viewByProject'],
	['post', '/offers/:id/withdraw', 'withdraw'], ['post', '/offers/:id/counter', 'counter'], ['post', '/offers/:id/negotiation/reject', 'reject']
]) {
	test(`${method.toUpperCase()} ${path} is provider-only`, () => {
		const line = src.split('\n').find((l) => l.includes(`router.${method}('${path}'`));
		assert.ok(line, 'route registered');
		assert.match(line!, /authenticate, requireActiveUser, providerOnly, providerOfferNegotiationController\./);
		assert.ok(line!.includes(`providerOfferNegotiationController.${handler}`));
	});
}
test('the negotiation controller takes the provider id from the token only', () => {
	const c = readFileSync(new URL('../controllers/provider-offer-negotiation.controller.ts', import.meta.url), 'utf8');
	assert.match(c, /req\.user!\.userId \|\| req\.user!\.id/);
	assert.doesNotMatch(c, /req\.body\.providerId|req\.body\.userId/);
});
