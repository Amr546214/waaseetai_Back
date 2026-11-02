import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Knowledge documents that belong to users are not a license of any administrative permission: only a SUPER_ADMIN is read as privileged, staff (ADMIN accounts) are read as guests.
process.env.JWT_SECRET = 'test-secret'; process.env.OPENAI_API_KEY = 'x';
const ACCOUNTS: Record<string, string> = { sa: 'SUPER_ADMIN', staff: 'ADMIN', staffAll: 'ADMIN', client: 'CLIENT_INDIVIDUAL' };
const seen: Array<{ who: string | undefined; demoted: boolean | undefined }> = [];
mock.module('../config/db', { namedExports: { prisma: {
	user: { findUnique: async ({ where }: any) => ({ accountType: ACCOUNTS[where.id] }) },
	// even a staff member that holds EVERY permission is not privileged for knowledge
	adminStaff: { findUnique: async () => ({ id: 's', status: 'ACTIVE', roleId: 'r', scoped: false, departments: [], overrides: [], role: { id: 'r', name: 'all', permissions: ['users.view', 'disputes.view', 'support.review'] } }) },
} } });
mock.module('../middlewares/auth.middleware', { namedExports: { optionalAuthenticate: (req: any, _res: any, next: any) => { const id = req.headers['x-who']; if (id) req.user = { id, userId: id, accountType: ACCOUNTS[String(id)], status: 'ACTIVE', activeRole: 'ADMIN' }; next(); } } });
const record = (req: any, res: any) => { seen.push({ who: req.user?.id, demoted: req.knowledgeAdminDemoted }); res.json({ ok: true }); };
mock.module('../controllers/knowledge.controller', { namedExports: { searchKnowledge: record, listKnowledgeDocs: record, getKnowledgeDoc: record } });
mock.module('../middlewares/rate-limit.middleware', { namedExports: { aiLimiter: (_q: any, _r: any, n: any) => n() } });

test('knowledge routes: only a SUPER_ADMIN keeps the privileged read; a staff member (any role) and a client are not marked privileged', async () => {
	const express = (await import('express')).default; const router = (await import('./knowledge.routes.ts')).default;
	const app = express(); app.use('/knowledge', router);
	const server = http.createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r())); const port = (server.address() as AddressInfo).port;
	try {
		for (const who of ['sa', 'staff', 'staffAll', 'client']) await fetch(`http://127.0.0.1:${port}/knowledge/doc1`, { headers: { 'x-who': who, connection: 'close' } }).then(r => r.arrayBuffer());
		const flag = (w: string) => seen.find(s => s.who === w)?.demoted;
		assert.equal(flag('sa'), undefined, 'a SUPER_ADMIN is not demoted');
		assert.equal(flag('staff'), true); assert.equal(flag('staffAll'), true);
		assert.equal(flag('client'), undefined, 'ordinary accounts are handled by the controller exactly as before');
	} finally { server.closeAllConnections(); server.close(); }
});
