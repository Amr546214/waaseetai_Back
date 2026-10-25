import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * REAL PostgreSQL (isolated local :55432, database qa_team) + the REAL admin-team router, services and permission guard over HTTP. Only `authenticate` is replaced: it reads the user id from
 * a header and loads that user from the database (the session / JWT layer has its own tests). Nothing here touches money: the finance / dispute routes are only asked WHETHER they let a
 * caller in (a refusal is 403; a pass ends in the real handler failing on a missing id, which is "not 403").
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
export const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432, database qa_team) to run' };
process.env.AUTH_RATE_LIMIT_MAX ??= '10000'; // the public invite routes sit behind the production 10/h limiter; the limiter has its own tests
process.env.JWT_SECRET ??= 'test-secret'; process.env.OPENAI_API_KEY ??= 'x'; process.env.FRONTEND_URL ??= 'https://front.test';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud'; process.env.CLOUDINARY_API_KEY ??= '123456789012345'; process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';

let setup: Promise<any> | null = null;
export async function env() {
	if (setup) return setup;
	setup = (async () => {
		const { prisma } = await import('../config/db');
		mock.module('../middlewares/auth.middleware', {
			namedExports: {
				authenticate: async (req: any, res: any, next: any) => {
					const id = req.headers['x-test-user'];
					const u = id ? await prisma.user.findUnique({ where: { id: String(id) } }) : null;
					if (!u) return res.status(401).json({ success: false, message: 'غير مصرح' });
					req.user = { id: u.id, userId: u.id, email: u.email, accountType: u.accountType, status: u.status, activeRole: u.activeRole, roles: u.roles, sessionId: 's' };
					next();
				},
				requireActiveUser: (req: any, res: any, next: any) => (req.user?.status === 'ACTIVE' ? next() : res.status(403).json({ success: false, message: 'الحساب غير نشط' })),
				authorize: () => (_q: any, _r: any, n: any) => n(), authorizeAdminActing: (_q: any, _r: any, n: any) => n(),
			},
		});
		const express = (await import('express')).default;
		const { globalErrorHandler } = await import('../middlewares/error.middleware');
		const team = (await import('../routes/admin-team.routes')).default;
		const pub = (await import('../routes/admin-team.routes')).adminInvitePublicRouter;
		const withdrawals = (await import('../routes/admin-withdrawals.routes')).default;
		const disputes = (await import('../routes/admin-disputes.routes')).default;
		const users = (await import('../routes/admin-users.routes')).default;
		const dashboard = (await import('../routes/admin-dashboard.routes')).default;
		const projects = await import('../routes/admin-projects.routes');
		const requests = await import('../routes/admin-requests.routes');
		const brokers = (await import('../routes/admin-brokers.routes')).default;
		const tickets = (await import('../routes/admin-tickets.routes')).default;
		const finance = (await import('../routes/admin-finance.routes')).default;
		const settings = (await import('../routes/admin-settings.routes')).default;
		const { notificationService } = await import('../services/notification.service');
		// the e-mail service never sends here: the invitation code is captured per address
		const sentCodes = new Map<string, string>();
		(notificationService as any).sendAdminInviteCodeEmail = async (to: string, code: string) => { sentCodes.set(to, code); return {}; };
		const app = express(); app.use(express.json());
		app.use('/admin/team', team); app.use('/admin-invite', pub); app.use('/admin/withdrawals', withdrawals); app.use('/admin/disputes', disputes); app.use('/admin/users', users); app.use('/admin/dashboard', dashboard);
		app.use('/admin/projects', projects.adminProjectsRouter); app.use('/admin/contracts', projects.adminContractsRouter); app.use('/admin/requests', requests.adminRequestsRouter); app.use('/admin/offers', requests.adminOffersRouter); app.use('/admin/brokers', brokers); app.use('/admin/tickets', tickets); app.use('/admin/finance', finance); app.use('/admin/settings', settings);
		app.use(globalErrorHandler as any);
		const server = http.createServer(app);
		await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as AddressInfo).port;
		const call = async (method: string, url: string, who?: string | null, body?: any) => {
			const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json', connection: 'close', ...(who ? { 'x-test-user': who } : {}) }, body: body === undefined || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body) });
			const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* csv */ }
			return { status: res.status, json, text };
		};
		const mkUser = async (accountType: string = 'ADMIN', tag = 'u') => prisma.user.create({ data: { id: randomUUID(), accountType: accountType as any, status: 'ACTIVE', roles: [accountType === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : accountType === 'ADMIN' ? 'ADMIN' : 'CLIENT'] as any, activeRole: (accountType === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : accountType === 'ADMIN' ? 'ADMIN' : 'CLIENT') as any, firstName: tag, lastName: 'T', email: `${tag}-${randomUUID().slice(0, 8)}@pg.test` } as any });
		// a SUPER_ADMIN account: its authority comes from the account TYPE only (no other table, no flag)
		const sa = await mkUser('SUPER_ADMIN', 'super');
		return { prisma, call, mkUser, sa, server, sentCodes };
	})();
	return setup;
}
export const mkRole = async (e: any, perms: string[], name?: string) => { const r = await e.call('POST', '/admin/team/roles', e.sa.id, { name: name ?? `دور ${randomUUID().slice(0, 6)}`, permissions: perms }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.data; };
export const mkStaff = async (e: any, perms: string[], tag = 'staff') => { const role = await mkRole(e, perms); const u = await e.mkUser('ADMIN', tag); await e.prisma.adminStaff.create({ data: { userId: u.id, roleId: role.id } }); return { user: u, role }; };

export async function closeEnv() { const e = await setup; if (e) { e.server.closeAllConnections?.(); await new Promise(r => e.server.close(r)); await e.prisma.$disconnect(); } }
