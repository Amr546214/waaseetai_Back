import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Governed Affiliate/Marketer profile-change-request flow (identity fields:
// NATIONAL_ID/PHONE_NUMBER/EMAIL, sourced from User — never AffiliateProfile,
// confirmed via marketer-profile.service.ts#getProfile's own `user: {
// select: { email, phoneNumber, idNumber } }`). These tests exercise the
// shared createGovernedFieldRequests helper through its identity-fields
// caller, against a fully mocked prisma client — no database is touched.

function createMockPrisma(t: TestContext, opts: {
	profile?: any;
	user?: any;
	existingRequests?: any[];
} = {}) {
	const profile = opts.profile ?? { id: 'aff-1', userId: 'user-1' };
	const user = opts.user ?? { id: 'user-1', firstName: 'OldFirst', lastName: 'OldLast', idNumber: '1000000000', phoneNumber: '0500000000', email: 'old@example.com' };
	const requests: any[] = opts.existingRequests ? [...opts.existingRequests] : [];

	const createSpy = t.mock.fn((args: any) => {
		const row = { id: `row-${requests.length + 1}`, ...args.data };
		requests.push(row);
		return row;
	});

	const findFirstPending = async (args: any) =>
		requests.find(r =>
			r.affiliateProfileId === args.where.affiliateProfileId &&
			r.fieldType === args.where.fieldType &&
			args.where.status.in.includes(r.status)
		) || null;

	const tx = {
		affiliateProfile: { findUnique: async () => profile },
		user: { findUnique: async () => user },
		profileChangeRequest: { findFirst: findFirstPending, create: createSpy }
	};

	const prismaMock: any = {
		$transaction: async (fn: any) => fn(tx),
		affiliateProfile: { findUnique: async () => profile },
		profileChangeRequest: {
			findMany: async (args: any) => requests.filter(r => r.affiliateProfileId === args.where.affiliateProfileId),
			findUnique: async (args: any) => requests.find(r => r.requestNumber === args.where.requestNumber) || null,
			update: async (args: any) => {
				const idx = requests.findIndex(r => r.requestNumber === args.where.requestNumber);
				requests[idx] = { ...requests[idx], ...args.data };
				return requests[idx];
			}
		}
	};

	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	return { createSpy, requests, profile, user };
}

async function loadService(t: TestContext, opts?: Parameters<typeof createMockPrisma>[1]) {
	const mocks = createMockPrisma(t, opts);
	const moduleUrl = `./profile-requests.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { profileRequestsService } = await import(moduleUrl);
	return { profileRequestsService, ...mocks };
}

test('createIdentityRequests: creates a NATIONAL_ID request when idNumber actually changes', async (t) => {
	const { profileRequestsService } = await loadService(t);
	const created = await profileRequestsService.createIdentityRequests('user-1', { nationalId: '2000000000' });

	assert.equal(created.length, 1);
	assert.equal(created[0].fieldType, 'NATIONAL_ID');
	assert.equal(created[0].affiliateProfileId, 'aff-1');
	assert.equal(created[0].currentValue, '1000000000');
	assert.equal(created[0].requestedValue, '2000000000');
	assert.equal(created[0].status, 'PENDING_AI_REVIEW');
});

test('createIdentityRequests: creates a PHONE_NUMBER request when phone actually changes', async (t) => {
	const { profileRequestsService } = await loadService(t);
	const created = await profileRequestsService.createIdentityRequests('user-1', { phoneNumber: '0511111111' });

	assert.equal(created.length, 1);
	assert.equal(created[0].fieldType, 'PHONE_NUMBER');
	assert.equal(created[0].requestedValue, '0511111111');
});

test('createIdentityRequests: creates a FIRST_NAME request when firstName actually changes', async (t) => {
	const { profileRequestsService } = await loadService(t);
	const created = await profileRequestsService.createIdentityRequests('user-1', { firstName: 'NewFirst' });

	assert.equal(created.length, 1);
	assert.equal(created[0].fieldType, 'FIRST_NAME');
	assert.equal(created[0].fieldLabel, 'الاسم الأول');
	assert.equal(created[0].currentValue, 'OldFirst');
	assert.equal(created[0].requestedValue, 'NewFirst');
	assert.equal(created[0].status, 'PENDING_AI_REVIEW');
});

test('createIdentityRequests: creates a LAST_NAME request when lastName actually changes', async (t) => {
	const { profileRequestsService } = await loadService(t);
	const created = await profileRequestsService.createIdentityRequests('user-1', { lastName: 'NewLast' });

	assert.equal(created.length, 1);
	assert.equal(created[0].fieldType, 'LAST_NAME');
	assert.equal(created[0].fieldLabel, 'اسم العائلة');
	assert.equal(created[0].currentValue, 'OldLast');
	assert.equal(created[0].requestedValue, 'NewLast');
});

test('createIdentityRequests: unchanged firstName/lastName are skipped (no rows created) when submitted alongside a real phone change', async (t) => {
	const { profileRequestsService } = await loadService(t);
	const created = await profileRequestsService.createIdentityRequests('user-1', {
		firstName: 'OldFirst',
		lastName: 'OldLast',
		phoneNumber: '0511111111'
	});

	assert.equal(created.length, 1);
	assert.equal(created[0].fieldType, 'PHONE_NUMBER');
});

test('createIdentityRequests: submitting the exact current firstName/lastName alone creates no request and rejects', async (t) => {
	const { profileRequestsService } = await loadService(t);
	await assert.rejects(
		() => profileRequestsService.createIdentityRequests('user-1', { firstName: 'OldFirst', lastName: 'OldLast' }),
		/لم يتم إجراء أي تغيير/
	);
});

test('createIdentityRequests: a duplicate pending FIRST_NAME request is rejected (409) and nothing new is created', async (t) => {
	const { profileRequestsService, requests } = await loadService(t, {
		existingRequests: [{ id: 'r1', affiliateProfileId: 'aff-1', fieldType: 'FIRST_NAME', status: 'PENDING_AI_REVIEW', requestNumber: 'REQ-1' }]
	});

	await assert.rejects(
		() => profileRequestsService.createIdentityRequests('user-1', { firstName: 'NewFirst' }),
		(error: any) => error.statusCode === 409
	);
	assert.equal(requests.length, 1);
});

test('createIdentityRequests: a duplicate pending LAST_NAME request is rejected (409) and nothing new is created', async (t) => {
	const { profileRequestsService, requests } = await loadService(t, {
		existingRequests: [{ id: 'r1', affiliateProfileId: 'aff-1', fieldType: 'LAST_NAME', status: 'PENDING_HUMAN_APPROVAL', requestNumber: 'REQ-1' }]
	});

	await assert.rejects(
		() => profileRequestsService.createIdentityRequests('user-1', { lastName: 'NewLast' }),
		(error: any) => error.statusCode === 409
	);
	assert.equal(requests.length, 1);
});

test('createIdentityRequests: creating a FIRST_NAME/LAST_NAME request never touches the real User row', async (t) => {
	const { profileRequestsService, user } = await loadService(t);
	await profileRequestsService.createIdentityRequests('user-1', { firstName: 'NewFirst', lastName: 'NewLast' });

	// The mock user object itself is never mutated by request creation (no
	// tx.user.update call exists anywhere in createIdentityRequests).
	assert.equal(user.firstName, 'OldFirst');
	assert.equal(user.lastName, 'OldLast');
});

test('createIdentityRequests: EMAIL is not a real input of this function anymore — defense in depth even if a caller bypasses the DTO', async (t) => {
	const { profileRequestsService } = await loadService(t);

	// Simulates an internal caller that bypassed the (now email-less)
	// CreateIdentityRequestSchema/IdentityChangeInput type — `email` is
	// simply never read, so no EMAIL row can ever be produced here.
	await assert.rejects(
		() => profileRequestsService.createIdentityRequests('user-1', { email: 'new@example.com' } as any),
		/لم يتم إجراء أي تغيير/
	);
});

test('createIdentityRequests: submitting the exact current value creates no request and rejects', async (t) => {
	const { profileRequestsService } = await loadService(t);
	await assert.rejects(
		() => profileRequestsService.createIdentityRequests('user-1', { nationalId: '1000000000' }),
		/لم يتم إجراء أي تغيير/
	);
});

test('createIdentityRequests: a duplicate pending request for the same field is rejected (409) and nothing new is created', async (t) => {
	const { profileRequestsService, requests } = await loadService(t, {
		existingRequests: [{ id: 'r1', affiliateProfileId: 'aff-1', fieldType: 'PHONE_NUMBER', status: 'PENDING_AI_REVIEW', requestNumber: 'REQ-1' }]
	});

	await assert.rejects(
		() => profileRequestsService.createIdentityRequests('user-1', { phoneNumber: '0511111111' }),
		(error: any) => error.statusCode === 409
	);
	assert.equal(requests.length, 1); // no new row created
});

test('createIdentityRequests: a PENDING_HUMAN_APPROVAL request also counts as a duplicate-blocking pending request', async (t) => {
	const { profileRequestsService } = await loadService(t, {
		existingRequests: [{ id: 'r1', affiliateProfileId: 'aff-1', fieldType: 'NATIONAL_ID', status: 'PENDING_HUMAN_APPROVAL', requestNumber: 'REQ-1' }]
	});

	await assert.rejects(() => profileRequestsService.createIdentityRequests('user-1', { nationalId: '2000000000' }));
});

test('createIdentityRequests: a REJECTED request for the same field does NOT block a new submission', async (t) => {
	const { profileRequestsService } = await loadService(t, {
		existingRequests: [{ id: 'r1', affiliateProfileId: 'aff-1', fieldType: 'PHONE_NUMBER', status: 'REJECTED', requestNumber: 'REQ-1' }]
	});

	const created = await profileRequestsService.createIdentityRequests('user-1', { phoneNumber: '0511111111' });
	assert.equal(created.length, 1);
});

test('withdrawRequest: another user cannot withdraw someone else\'s request', async (t) => {
	const { profileRequestsService } = await loadService(t, {
		existingRequests: [{ id: 'r1', affiliateProfileId: 'aff-OTHER-USER', fieldType: 'IBAN', status: 'PENDING_AI_REVIEW', requestNumber: 'REQ-1' }]
	});

	await assert.rejects(() => profileRequestsService.withdrawRequest('user-1', 'REQ-1'), /Unauthorized/);
});

test('getRequests: returns newly-created requests for this affiliate (marketer request history)', async (t) => {
	const { profileRequestsService } = await loadService(t);
	await profileRequestsService.createIdentityRequests('user-1', { nationalId: '2000000000', phoneNumber: '0511111111' });

	const summary = await profileRequestsService.getRequests('user-1');
	assert.equal(summary.totalRequests, 2);
	assert.equal(summary.pendingAiCount, 2);
	const fieldTypes = summary.items.map((r: any) => r.fieldType).sort();
	assert.deepEqual(fieldTypes, ['NATIONAL_ID', 'PHONE_NUMBER']);
});

test('getRequests: name change requests (FIRST_NAME/LAST_NAME) appear in marketer request history', async (t) => {
	const { profileRequestsService } = await loadService(t);
	await profileRequestsService.createIdentityRequests('user-1', { firstName: 'NewFirst', lastName: 'NewLast' });

	const summary = await profileRequestsService.getRequests('user-1');
	assert.equal(summary.totalRequests, 2);
	const fieldTypes = summary.items.map((r: any) => r.fieldType).sort();
	assert.deepEqual(fieldTypes, ['FIRST_NAME', 'LAST_NAME']);
	const labels = summary.items.map((r: any) => r.fieldLabel).sort();
	assert.deepEqual(labels, ['اسم العائلة', 'الاسم الأول']);
});
