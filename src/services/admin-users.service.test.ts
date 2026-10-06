import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// AI Cleanup Batch 3 — admin users CSV export / list. `prisma` (via
// ../config/db) is mocked; no real DB/network call ever happens. These tests
// prove the fabricated "Risk Level" / "Risk Score" columns (schema defaults
// LOW / 10 that no code path ever writes) are gone from the export and the
// list response, while every legitimate exported field is preserved.

function userRow(overrides: Record<string, any> = {}) {
	return {
		id: 'user-1',
		firstName: 'Saad',
		lastName: 'Ghamdi',
		accountHolderName: null,
		email: 's@example.com',
		phoneNumber: '+966500000000',
		accountType: 'CLIENT',
		status: 'ACTIVE',
		// Present on the DB row (schema defaults) — must never surface.
		aiRiskLevel: 'LOW',
		aiRiskScore: 10,
		aiSuspiciousNotes: null,
		totalGmvAmount: 1234.5,
		completedProjectsCount: 3,
		ratingAverage: 4.5,
		tierLevel: 'Gold',
		lastActiveAt: new Date('2026-09-01T10:00:00.000Z'),
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		clientProfile: null,
		providerProfile: null,
		affiliateProfile: null,
		...overrides,
	};
}

function mockPrisma(t: TestContext, rows: any[]) {
	const findManySpy = t.mock.fn(async (args: any) => (args?.skip ? [] : rows));
	const prismaMock: any = {
		user: { findMany: findManySpy, count: t.mock.fn(async () => rows.length) },
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	return { findManySpy };
}

async function loadService(t: TestContext, rows: any[]) {
	const { findManySpy } = mockPrisma(t, rows);
	const moduleUrl = `./admin-users.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { AdminUsersService } = await import(moduleUrl);
	return { service: new AdminUsersService(), findManySpy };
}

const EXPECTED_HEADERS = [
	'User ID',
	'Name',
	'Email',
	'Phone Number',
	'Account Type',
	'Status',
	'Total GMV (USD)',
	'Completed Projects',
	'Rating Average',
	'Tier Level',
	'Last Active',
	'Created At',
];

test('exportCsv: no Risk Level / Risk Score column in the header', async (t) => {
	const { service } = await loadService(t, [userRow()]);
	const csv: string = await service.exportCsv({});
	const header = csv.split('\n')[0];
	assert.equal(/risk/i.test(header), false, `risk column leaked: ${header}`);
	assert.deepEqual(header.split(','), EXPECTED_HEADERS);
});

test('exportCsv: rows keep every legitimate field and carry no risk values', async (t) => {
	const { service } = await loadService(t, [userRow()]);
	const csv: string = await service.exportCsv({});
	const lines = csv.split('\n');
	assert.equal(lines.length, 2);
	const cells = lines[1].split(',');
	assert.equal(cells.length, EXPECTED_HEADERS.length);
	assert.deepEqual(cells, [
		'"user-1"',
		'"Saad Ghamdi"',
		'"s@example.com"',
		'"+966500000000"',
		'"CLIENT"',
		'"ACTIVE"',
		'1234.50',
		'3',
		'4.5',
		'"Gold"',
		'"2026-09-01T10:00:00.000Z"',
		'"2026-01-01T00:00:00.000Z"',
	]);
	assert.equal(lines[1].includes('LOW'), false);
});

test('exportCsv: never selects aiRiskLevel / aiRiskScore from the DB', async (t) => {
	const { service, findManySpy } = await loadService(t, [userRow()]);
	await service.exportCsv({});
	const select = findManySpy.mock.calls[0].arguments[0].select;
	assert.equal('aiRiskLevel' in select, false);
	assert.equal('aiRiskScore' in select, false);
	for (const field of ['id', 'email', 'phoneNumber', 'accountType', 'status', 'totalGmvAmount', 'completedProjectsCount', 'ratingAverage', 'tierLevel', 'lastActiveAt', 'createdAt']) {
		assert.equal(select[field], true, `legitimate field not selected: ${field}`);
	}
});

test('getUsers: list response no longer carries fabricated risk / aiRiskScore fallbacks', async (t) => {
	const { service } = await loadService(t, [userRow({ aiRiskLevel: null, aiRiskScore: 0 })]);
	const result = await service.getUsers({});
	const u = result.users[0];
	assert.equal('risk' in u, false);
	assert.equal('aiRiskScore' in u, false);
	assert.equal('aiRiskLevel' in u, false);
	assert.equal(u.email, 's@example.com');
	assert.equal(u.statusOriginal, 'ACTIVE');
	assert.equal(u.projects, 3);
});

test('AdminUsersController.exportCsv: responds 200 with a CSV attachment and no risk columns', async (t) => {
	mockPrisma(t, [userRow()]);
	const moduleUrl = `../controllers/admin-users.controller.ts?fixture=${Date.now()}-${Math.random()}`;
	const { AdminUsersController } = await import(moduleUrl);

	const headers: Record<string, string> = {};
	let statusCode = 0;
	let body = '';
	const res: any = {
		setHeader: (k: string, v: string) => { headers[k] = v; },
		status(code: number) { statusCode = code; return this; },
		send(payload: string) { body = payload; return this; },
	};
	const next = t.mock.fn();

	await AdminUsersController.exportCsv({ query: {} } as any, res, next as any);

	assert.equal(next.mock.callCount(), 0);
	assert.equal(statusCode, 200);
	assert.equal(headers['Content-Type'], 'text/csv; charset=utf-8');
	assert.match(headers['Content-Disposition'], /users-export\.csv/);
	const csv = body.replace(/^﻿/, '');
	assert.deepEqual(csv.split('\n')[0].split(','), EXPECTED_HEADERS);
	assert.equal(/risk/i.test(csv), false);
});
