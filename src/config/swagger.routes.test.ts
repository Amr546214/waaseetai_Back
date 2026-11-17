import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { Router } from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountRouter } from '../utils/mount-router';
import { createOpenApiDocument } from './swagger';

test('nested Express 5 mounts retain their full documented paths without flattening or changing auth order', async () => {
  const app = express();
  const api = Router(), provider = Router(), team = Router();
  const order: string[] = [];
  provider.use((req, res, next) => {
    order.push('auth');
    if (!req.headers.authorization) { res.status(401).json({ success: false }); return; }
    next();
  });
  team.use((_req, _res, next) => { order.push('team'); next(); });
  team.get('/', (_req, res) => res.json({ ok: true }));
  team.get('/:id', (req, res) => res.json({ id: req.params.id }));
  mountRouter(provider, '/company/team', team);
  mountRouter(api, '/provider', provider);
  app.use('/api', api);
  (app.router.stack.at(-1) as unknown as { __swaggerPath: string }).__swaggerPath = '/api';
  const paths = createOpenApiDocument(app).paths;
  assert.ok(paths['/api/provider/company/team']?.get);
  assert.ok(paths['/api/provider/company/team/:id']?.get);
  assert.equal(paths['/api/provider'], undefined);
  assert.equal(paths['/api/provider/:id'], undefined);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/provider/company/team/member-1`;
  try {
    const refused = await fetch(url); await refused.arrayBuffer();
    assert.equal(refused.status, 401); assert.deepEqual(order, ['auth']); order.length = 0;
    const allowed = await fetch(url, { headers: { Authorization: 'test' } });
    assert.equal(allowed.status, 200); assert.deepEqual(await allowed.json(), { id: 'member-1' });
    assert.deepEqual(order, ['auth', 'team']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
