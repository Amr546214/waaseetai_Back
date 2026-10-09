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
			// unused-number lookup done before every create (a requestNumber collision must not abort the batch)
			findUnique: async (args: any) => requests.find(r => r.requestNumber === args.where.requestNumber) || null,
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

async function loadPaypalService(t: TestContext, updateImpl: (args: any) => any) {
	const updateSpy = t.mock.fn(async (args: any) => updateImpl(args));
	t.mock.module('../config/db', { namedExports: { prisma: { affiliateProfile: {
		update: updateSpy,
		findUnique: async () => ({ avatarUrl: null, bio: null, paypalPayoutEmail: 'm@example.com', marketingChannels: [], user: {} }),
	} } } });
	const { marketerProfileService } = await import(`./marketer-profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
	return { marketerProfileService, updateSpy };
}

test('updatePaypalPayout: saves the PayPal email (trimmed, lower-case) and writes no bank column', async (t) => {
	const { marketerProfileService, updateSpy } = await loadPaypalService(t, (a) => ({ id: 'aff-1', ...a.data }));
	const result = await marketerProfileService.updatePaypalPayout('user-1', '  Marketer@Example.com ');
	assert.equal(result.paypalPayoutEmail, 'marketer@example.com');
	const first = updateSpy.mock.calls[0].arguments[0];
	assert.deepEqual(first.data, { paypalPayoutEmail: 'marketer@example.com' });
	for (const call of updateSpy.mock.calls) for (const k of ['iban', 'bankName', 'accountHolderName', 'swiftCode']) assert.equal(k in call.arguments[0].data, false);
});

test('updatePaypalPayout: an empty value removes the saved email', async (t) => {
	const { marketerProfileService, updateSpy } = await loadPaypalService(t, (a) => ({ id: 'aff-1', ...a.data }));
	await marketerProfileService.updatePaypalPayout('user-1', '');
	assert.deepEqual(updateSpy.mock.calls[0].arguments[0].data, { paypalPayoutEmail: null });
});

test('updatePaypalPayout: a database without the column answers a clear 503, not a raw error', async (t) => {
	const { marketerProfileService } = await loadPaypalService(t, () => { throw Object.assign(new Error('column does not exist'), { code: 'P2022' }); });
	await assert.rejects(() => marketerProfileService.updatePaypalPayout('user-1', 'a@b.com'), (e: any) => e.statusCode === 503);
});

test('PayPal-only payload: any bank / IBAN / holder / wallet / swift field is rejected by the schema (nothing reaches the service)', async () => {
	const { updatePaypalPayoutSchema } = await import('../dtos/marketer-profile.dto');
	assert.equal(updatePaypalPayoutSchema.safeParse({ paypalPayoutEmail: 'a@b.com' }).success, true);
	assert.equal(updatePaypalPayoutSchema.safeParse({ paypalPayoutEmail: '' }).success, true);
	assert.equal(updatePaypalPayoutSchema.safeParse({ paypalPayoutEmail: 'not-an-email' }).success, false);
	for (const extra of [{ iban: 'SA0311000000000000000001' }, { bankName: 'x' }, { accountHolderName: 'x' }, { swiftCode: 'RIBLSARI' }, { walletNumber: '1' }, { walletProvider: 'x' }]) {
		const r = updatePaypalPayoutSchema.safeParse({ paypalPayoutEmail: 'a@b.com', ...extra });
		assert.equal(r.success, false, JSON.stringify(extra));
		assert.match(r.error!.issues[0].message, /PayPal/);
	}
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

// ============================================================================
// Deployment-safety regression coverage (P-LG-012 affiliate commission
// engine rollout). AffiliateProfile.level exists in prisma/schema.prisma but
// its migration has NOT been applied to DEV/LIVE. getProfile() previously
// used a bare `include` (which does not restrict AffiliateProfile's own
// scalars), and addChannel() previously called findUnique with no select at
// all — both would have requested the not-yet-existing `level` column and
// 500'd the marketer's own profile page / channel-add flow.
// ============================================================================

function fullProfileFixture(overrides: Record<string, any> = {}) {
	// Shaped exactly like the CURRENT (pre-migration) DB row would actually
	// look — every existing AffiliateProfile scalar present, `level` absent.
	return {
		id: 'aff-1',
		userId: 'user-1',
		referralSlug: 'khalid-1',
		currentLevel: 'مساعد',
		commissionRatePercentage: 5,
		notifyOnNewReferral: true,
		sharePerformanceStats: false,
		firstName: 'خالد',
		lastName: 'الغامدي',
		avatarUrl: null,
		bio: null,
		bankName: null,
		accountHolderName: null,
		iban: null,
		swiftCode: null,
		identityVerified: false,
		kycDocumentUrl: null,
		payoutMethod: 'BANK_TRANSFER',
		minimumPayoutAmount: 300,
		completionPercentage: 45,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		user: { firstName: 'Khalid', lastName: 'Ghamdi', email: 'khalid@example.com', phoneNumber: null, phoneCountryCode: null, idNumber: null, avatarUrl: null },
		marketingChannels: [],
		...overrides,
	};
}

test('getProfile: selects AffiliateProfile scalars explicitly (never a bare `include`) and never requests `level`', async (t) => {
	const findUniqueSpy = t.mock.fn(async () => fullProfileFixture());
	const prismaMock: any = { affiliateProfile: { findUnique: findUniqueSpy } };
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const moduleUrl = `./marketer-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { marketerProfileService } = await import(moduleUrl);

	await marketerProfileService.getProfile('user-1');

	// the profile read, plus the separate PayPal-email read (so a database without that column cannot fail the whole profile)
	assert.equal(findUniqueSpy.mock.callCount(), 2);
	assert.deepEqual(findUniqueSpy.mock.calls[1].arguments[0].select, { paypalPayoutEmail: true });
	const args = findUniqueSpy.mock.calls[0].arguments[0];
	assert.ok(args.select, 'must pass an explicit select');
	assert.equal('level' in args.select, false);
	// The nested `user` select (already safe/pre-existing) and
	// `marketingChannels` relation must still be present — same response
	// shape as before this fix.
	assert.ok(args.select.user);
	assert.equal(args.select.marketingChannels, true);
});

test('getProfile: returns the profile built from a fixture row shaped exactly like the pre-migration DB (no `level` field present at all)', async (t) => {
	const prismaMock: any = { affiliateProfile: { findUnique: async () => fullProfileFixture() } };
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const moduleUrl = `./marketer-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { marketerProfileService } = await import(moduleUrl);

	const profile = await marketerProfileService.getProfile('user-1');

	assert.equal(profile.id, 'aff-1');
	assert.equal(profile.referralSlug, 'khalid-1');
	assert.equal(profile.currentLevel, 'مساعد');
	assert.equal('level' in profile, false);
});

test('getProfile: throws when the profile does not exist', async (t) => {
	const prismaMock: any = { affiliateProfile: { findUnique: async () => null } };
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const moduleUrl = `./marketer-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { marketerProfileService } = await import(moduleUrl);

	await assert.rejects(() => marketerProfileService.getProfile('missing-user'));
});

test('addChannel: the profile lookup selects only { id: true } and never `level`, and still creates the channel correctly', async (t) => {
	const findUniqueSpy = t.mock.fn(async () => ({ id: 'aff-1' }));
	const createSpy = t.mock.fn((args: any) => ({ id: 'channel-1', ...args.data }));
	const prismaMock: any = {
		affiliateProfile: { findUnique: findUniqueSpy, update: t.mock.fn(async () => ({ id: 'aff-1' })) },
		affiliateChannelHandle: { create: createSpy },
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const moduleUrl = `./marketer-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { marketerProfileService } = await import(moduleUrl);

	// recalculateCompletion() runs after the create — give it a minimal
	// profile + user fixture so it doesn't throw.
	prismaMock.affiliateProfile.findUnique = t.mock.fn(async (args: any) => {
		findUniqueSpy(args);
		return args.select?.id !== undefined && Object.keys(args.select).length === 1
			? { id: 'aff-1' }
			: { avatarUrl: null, bio: null, marketingChannels: [], user: { firstName: 'Khalid', lastName: 'Ghamdi', email: 'k@example.com', avatarUrl: null } };
	});

	const channel = await marketerProfileService.addChannel('user-1', { platform: 'INSTAGRAM', handle: '@khalid' });

	assert.equal(channel.platform, 'INSTAGRAM');
	assert.equal(createSpy.mock.calls[0].arguments[0].data.affiliateProfileId, 'aff-1');
	// First call is addChannel()'s own lookup (the one under test); the
	// second is recalculateCompletion()'s separate, already-narrow lookup.
	assert.equal(findUniqueSpy.mock.callCount(), 3); // + the PayPal-email read of the completion recalculation
	const args = findUniqueSpy.mock.calls[0].arguments[0];
	assert.deepEqual(args.select, { id: true });
	assert.equal('level' in args.select, false);
});

test('addChannel: throws when no affiliate profile exists for this user', async (t) => {
	const prismaMock: any = { affiliateProfile: { findUnique: async () => null } };
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	const moduleUrl = `./marketer-profile.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { marketerProfileService } = await import(moduleUrl);

	await assert.rejects(() => marketerProfileService.addChannel('user-1', { platform: 'INSTAGRAM', handle: '@khalid' }));
});
