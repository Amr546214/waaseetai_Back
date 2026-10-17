import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// post-Batch-B fix 2 (static guards; the behaviour is proven on real PostgreSQL in pg-own-service-surfaces.pg.test.ts)
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('static: the recommendations route reads the optional session and the controller hands req.user to the service', () => {
	assert.match(read('../routes/marketplace.routes.ts'), /router\.post\('\/ai-recommendations', optionalAuthenticate, aiLimiter,/);
	assert.match(read('../controllers/marketplace-service.controller.ts'), /getAiRecommendations\(req\.body, req\.user\)/);
});

test('static: listing and recommendations compare the OWNER USER id (providerId / provider.id) with the authenticated id, never a name or the active role', () => {
	const src = read('./marketplace-service.service.ts');
	assert.match(src, /isOwnService: s\.providerId === requestingUser\.id/);
	assert.match(src, /isOwnService: r\?\.provider\?\.id === requestingUser\.id/);
	assert.ok(!/isOwnService[^\n]*(activeRole|firstName|lastName|\.name)/.test(src));
});
