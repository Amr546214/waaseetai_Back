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

// Implementation Batch 3, Part A — public marketer profile. These tests
// prove the response is an explicit allowlist (never bank/IBAN/KYC/email/
// phone/commissionRatePercentage), that channelMetrics is only present when
// the marketer opted in via sharePerformanceStats, and that no real DB
// write ever happens on this read path.

function publicProfileFixture(overrides: Record<string, any> = {}) {
	return {
		id: 'aff-1',
		firstName: 'خالد',
		lastName: 'الغامدي',
		avatarUrl: 'https://cdn.example.com/avatar.png',
		bio: 'سيرة ذاتية حقيقية',
		currentLevel: 'مساعد',
		identityVerified: true,
		sharePerformanceStats: false,
		user: { firstName: 'Khalid', lastName: 'Ghamdi', avatarUrl: null },
		marketingChannels: [{ platform: 'INSTAGRAM', handle: '@khalid', url: 'https://instagram.com/khalid' }],
		...overrides,
	};
}

async function loadServiceWithPublicProfileMock(t: TestContext, opts: {
	profile?: any;
	channelMetrics?: any[];
}) {
	const findUniqueSpy = t.mock.fn(async () => (opts.profile === undefined ? publicProfileFixture() : opts.profile));
	const channelMetricFindManySpy = t.mock.fn(async () => opts.channelMetrics ?? []);
	// Deliberately no `update`/`create` on either model — any attempted
	// write would throw, proving this is a pure read.
	const prismaMock: any = {
		affiliateProfile: { findUnique: findUniqueSpy },
		affiliateChannelMetric: { findMany: channelMetricFindManySpy },
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });

	const moduleUrl = `./marketer-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { marketerProfileService } = await import(moduleUrl);
	return { marketerProfileService, findUniqueSpy, channelMetricFindManySpy };
}

test('getPublicProfile: returns only the explicit allowlisted fields for a real marketer', async (t) => {
	const { marketerProfileService } = await loadServiceWithPublicProfileMock(t, {});

	const result = await marketerProfileService.getPublicProfile('user-1');

	assert.deepEqual(Object.keys(result).sort(), ['avatarUrl', 'bio', 'channelMetrics', 'channels', 'id', 'identityVerified', 'level', 'name'].sort());
	assert.equal(result.name, 'خالد الغامدي');
	assert.equal(result.bio, 'سيرة ذاتية حقيقية');
	assert.equal(result.level, 'مساعد');
	assert.equal(result.identityVerified, true);
	assert.deepEqual(result.channels, [{ platform: 'INSTAGRAM', handle: '@khalid', url: 'https://instagram.com/khalid' }]);
});

test('getPublicProfile: never exposes bank/IBAN/KYC/email/phone/commission fields even if present on the underlying row', async (t) => {
	const { marketerProfileService } = await loadServiceWithPublicProfileMock(t, {
		profile: publicProfileFixture({
			iban: 'SA0311000000000000000001',
			bankName: 'بنك الرياض',
			accountHolderName: 'Khalid',
			swiftCode: 'RIBLSARI',
			identityVerified: true,
			kycDocumentUrl: 'https://cdn.example.com/id.pdf',
			commissionRatePercentage: 12,
			payoutMethod: 'BANK_TRANSFER',
			user: { firstName: 'Khalid', lastName: 'Ghamdi', avatarUrl: null, email: 'khalid@example.com', phoneNumber: '+966500000000' },
		}),
	});

	const result: any = await marketerProfileService.getPublicProfile('user-1');
	const serialized = JSON.stringify(result);

	for (const forbidden of ['SA0311000000000000000001', 'بنك الرياض', 'RIBLSARI', 'kycDocumentUrl', 'khalid@example.com', '+966500000000', 'commissionRatePercentage', 'iban', 'payoutMethod']) {
		assert.equal(serialized.includes(forbidden), false, `leaked forbidden field/value: ${forbidden}`);
	}
});

test('getPublicProfile: throws a real 404 for a marketer that does not exist, without querying channel metrics', async (t) => {
	const { marketerProfileService, channelMetricFindManySpy } = await loadServiceWithPublicProfileMock(t, { profile: null });

	await assert.rejects(() => marketerProfileService.getPublicProfile('missing-user'), (error: any) => {
		assert.equal(error.statusCode, 404);
		return true;
	});
	assert.equal(channelMetricFindManySpy.mock.callCount(), 0);
});

test('getPublicProfile: channelMetrics is null (not an empty array) when the marketer has not opted in to sharePerformanceStats', async (t) => {
	const { marketerProfileService, channelMetricFindManySpy } = await loadServiceWithPublicProfileMock(t, {
		profile: publicProfileFixture({ sharePerformanceStats: false }),
	});

	const result = await marketerProfileService.getPublicProfile('user-1');

	assert.equal(result.channelMetrics, null);
	assert.equal(channelMetricFindManySpy.mock.callCount(), 0);
});

test('getPublicProfile: returns real channelMetrics when the marketer opted in via sharePerformanceStats', async (t) => {
	const realMetrics = [{ channel: 'INSTAGRAM', visitors: 340, clients: 12, conversionPercentage: 3.5 }];
	const { marketerProfileService } = await loadServiceWithPublicProfileMock(t, {
		profile: publicProfileFixture({ sharePerformanceStats: true }),
		channelMetrics: realMetrics,
	});

	const result = await marketerProfileService.getPublicProfile('user-1');

	assert.deepEqual(result.channelMetrics, realMetrics);
});

test('getPublicProfile: falls back to the legacy User name/avatar only when the affiliate-specific fields are empty', async (t) => {
	const { marketerProfileService } = await loadServiceWithPublicProfileMock(t, {
		profile: publicProfileFixture({ firstName: null, lastName: null, avatarUrl: null, user: { firstName: 'Khalid', lastName: 'Ghamdi', avatarUrl: 'https://cdn.example.com/legacy.png' } }),
	});

	const result = await marketerProfileService.getPublicProfile('user-1');

	assert.equal(result.name, 'Khalid Ghamdi');
	assert.equal(result.avatarUrl, 'https://cdn.example.com/legacy.png');
});

test('getPublicProfile: performs zero DB writes on the read path', async (t) => {
	const findUniqueSpy = t.mock.fn(async () => publicProfileFixture({ sharePerformanceStats: true }));
	const channelMetricFindManySpy = t.mock.fn(async () => []);
	const prismaMock: any = {
		affiliateProfile: { findUnique: findUniqueSpy },
		affiliateChannelMetric: { findMany: channelMetricFindManySpy },
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const moduleUrl = `./marketer-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { marketerProfileService } = await import(moduleUrl);

	await marketerProfileService.getPublicProfile('user-1');

	// No update/create function exists on either mocked model at all — if
	// the code under test ever tried to write, it would throw "not a
	// function" and this test would fail.
	assert.equal(findUniqueSpy.mock.callCount(), 1);
	assert.equal(channelMetricFindManySpy.mock.callCount(), 1);
});
