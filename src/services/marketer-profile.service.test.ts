import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Banking-tab governance fix: the page's own "gov-bar" copy claims editing
// "الحساب البنكي والمستندات" is fully governed, but previously only IBAN
// created a ProfileChangeRequest while bankName/accountHolderName/swiftCode
// were written directly. All four fields now go through the same governed
// request flow (via the shared createGovernedFieldRequests helper) — none
// are written to AffiliateProfile immediately anymore.

function createMockPrisma(t: TestContext, opts: {
	profile?: any;
	existingRequests?: any[];
} = {}) {
	const profile = opts.profile ?? { id: 'aff-1', userId: 'user-1', iban: null, bankName: null, accountHolderName: null, swiftCode: null };
	const requests: any[] = opts.existingRequests ? [...opts.existingRequests] : [];

	const createSpy = t.mock.fn((args: any) => {
		const row = { id: `row-${requests.length + 1}`, ...args.data };
		requests.push(row);
		return row;
	});

	const affiliateUpdateSpy = t.mock.fn((args: any) => ({ ...profile, ...args.data }));

	const tx = {
		affiliateProfile: { findUnique: async () => profile, update: affiliateUpdateSpy },
		profileChangeRequest: {
			findFirst: async (args: any) => requests.find(r =>
				r.affiliateProfileId === args.where.affiliateProfileId &&
				r.fieldType === args.where.fieldType &&
				args.where.status.in.includes(r.status)
			) || null,
			create: createSpy
		}
	};

	const prismaMock: any = { $transaction: async (fn: any) => fn(tx) };
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	return { createSpy, affiliateUpdateSpy, requests, profile };
}

async function loadService(t: TestContext, opts?: Parameters<typeof createMockPrisma>[1]) {
	const mocks = createMockPrisma(t, opts);
	const moduleUrl = `./marketer-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { marketerProfileService } = await import(moduleUrl);
	return { marketerProfileService, ...mocks };
}

test('updateBankInfo: IBAN change creates a governed request, never a direct AffiliateProfile write (existing behavior preserved)', async (t) => {
	const { marketerProfileService, affiliateUpdateSpy } = await loadService(t);

	const result = await marketerProfileService.updateBankInfo('user-1', { iban: 'SA0311000000000000000001' });

	assert.equal(result.success, true);
	assert.equal(result.isPendingRequest, true);
	assert.equal(result.requests.length, 1);
	assert.equal(result.requests[0].fieldType, 'IBAN');
	assert.equal(affiliateUpdateSpy.mock.callCount(), 0);
});

test('updateBankInfo: bankName/accountHolderName/swiftCode are now ALSO governed — no immediate write for any of them', async (t) => {
	const { marketerProfileService, affiliateUpdateSpy } = await loadService(t);

	const result = await marketerProfileService.updateBankInfo('user-1', {
		bankName: 'بنك الرياض',
		accountHolderName: 'Amr Okasha',
		swiftCode: 'RIBLSARI'
	});

	assert.equal(result.requests.length, 3);
	assert.equal(affiliateUpdateSpy.mock.callCount(), 0);
	const fieldTypes = result.requests.map((r: any) => r.fieldType).sort();
	assert.deepEqual(fieldTypes, ['ACCOUNT_HOLDER_NAME', 'BANK_NAME', 'SWIFT_CODE']);
});

test('updateBankInfo: all four fields changed together create four independent request rows', async (t) => {
	const { marketerProfileService } = await loadService(t);

	const result = await marketerProfileService.updateBankInfo('user-1', {
		iban: 'SA0311000000000000000001',
		bankName: 'بنك الرياض',
		accountHolderName: 'Amr Okasha',
		swiftCode: 'RIBLSARI'
	});

	assert.equal(result.requests.length, 4);
});

test('updateBankInfo: resubmitting the exact current values throws (no change)', async (t) => {
	const { marketerProfileService } = await loadService(t, {
		profile: { id: 'aff-1', userId: 'user-1', iban: 'SA0311000000000000000001', bankName: null, accountHolderName: null, swiftCode: null }
	});

	await assert.rejects(() => marketerProfileService.updateBankInfo('user-1', { iban: 'SA0311000000000000000001' }));
});

test('updateBankInfo: a duplicate pending IBAN request blocks resubmission with 409, no new row created', async (t) => {
	const { marketerProfileService, requests } = await loadService(t, {
		existingRequests: [{ id: 'r1', affiliateProfileId: 'aff-1', fieldType: 'IBAN', status: 'PENDING_AI_REVIEW', requestNumber: 'REQ-1' }]
	});

	await assert.rejects(
		() => marketerProfileService.updateBankInfo('user-1', { iban: 'SA9999999999999999999999' }),
		(error: any) => error.statusCode === 409
	);
	assert.equal(requests.length, 1);
});
