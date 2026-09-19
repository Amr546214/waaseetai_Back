import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Admin review surface for AffiliateProfile's ProfileChangeRequest. Verifies
// the fieldType -> real column mapping (User vs AffiliateProfile), the
// approve/reject transactional guarantees, and the finalized/withdrawn
// re-review guards — against a fully mocked prisma + notification service,
// no database and no real socket/email side effects.

function createMockPrisma(t: TestContext, opts: {
	request?: any;
	profile?: any;
} = {}) {
	const profile = opts.profile ?? { id: 'aff-1', userId: 'user-1', iban: null, bankName: null, accountHolderName: null, swiftCode: null };
	let request = opts.request ?? {
		id: 'req-1', affiliateProfileId: 'aff-1', fieldType: 'EMAIL', fieldLabel: 'البريد الإلكتروني',
		requestedValue: 'new@example.com', currentValue: 'old@example.com', status: 'PENDING_AI_REVIEW', requestNumber: 'REQ-1'
	};

	const userUpdateSpy = t.mock.fn((args: any) => ({ id: args.where.id, ...args.data }));
	const affiliateUpdateSpy = t.mock.fn((args: any) => ({ ...profile, ...args.data }));
	const notifySpy = t.mock.fn(async () => ({}));

	const tx = {
		profileChangeRequest: {
			findUnique: async () => request,
			update: async (args: any) => {
				request = { ...request, ...args.data };
				return { ...request, affiliateProfile: { userId: profile.userId } };
			}
		},
		affiliateProfile: { findUnique: async () => profile, update: affiliateUpdateSpy },
		user: { update: userUpdateSpy }
	};

	const prismaMock: any = { $transaction: async (fn: any) => fn(tx) };

	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: notifySpy } } });

	return { userUpdateSpy, affiliateUpdateSpy, notifySpy, getRequest: () => request };
}

async function loadService(t: TestContext, opts?: Parameters<typeof createMockPrisma>[1]) {
	const mocks = createMockPrisma(t, opts);
	const moduleUrl = `./admin-affiliate-requests.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { adminAffiliateRequestsService } = await import(moduleUrl);
	return { adminAffiliateRequestsService, ...mocks };
}

// Post-safety-review decision: EMAIL must NOT be applicable through this
// flow at all (no email-ownership verification exists, and Google OAuth's
// existing-user lookup matches by email — see admin-affiliate-requests.
// service.ts#applyFieldChange). The public create endpoint can no longer
// produce an EMAIL request, but SensitiveFieldType.EMAIL still exists on the
// enum and a historical/legacy row could in principle exist, so approval
// must fail closed rather than silently applying it.
test('approve: an EMAIL request is refused with a controlled error — User.email is never touched', async (t) => {
	const { adminAffiliateRequestsService, userUpdateSpy, affiliateUpdateSpy, notifySpy, getRequest } = await loadService(t);

	await assert.rejects(
		() => adminAffiliateRequestsService.approve('req-1', 'admin-1'),
		(error: any) => error.statusCode === 409 && /مسارًا منفصلاً/.test(error.message)
	);

	assert.equal(userUpdateSpy.mock.callCount(), 0);
	assert.equal(affiliateUpdateSpy.mock.callCount(), 0);
	assert.equal(notifySpy.mock.callCount(), 0);
});

test('approve: an EMAIL request is refused — the request itself stays PENDING (never marked APPROVED_AND_APPLIED)', async (t) => {
	const { adminAffiliateRequestsService, getRequest } = await loadService(t);

	await assert.rejects(() => adminAffiliateRequestsService.approve('req-1', 'admin-1'));

	assert.equal(getRequest().status, 'PENDING_AI_REVIEW');
	assert.equal(getRequest().reviewedBy, undefined);
	assert.equal(getRequest().appliedAt, undefined);
});

test('approve: PHONE_NUMBER request applies to User.phoneNumber', async (t) => {
	const { adminAffiliateRequestsService, userUpdateSpy } = await loadService(t, {
		request: { id: 'req-2', affiliateProfileId: 'aff-1', fieldType: 'PHONE_NUMBER', fieldLabel: 'رقم الجوال', requestedValue: '0511111111', currentValue: '0500000000', status: 'PENDING_AI_REVIEW', requestNumber: 'REQ-2' }
	});

	await adminAffiliateRequestsService.approve('req-2', 'admin-1');
	assert.equal(userUpdateSpy.mock.calls[0].arguments[0].data.phoneNumber, '0511111111');
});

test('approve: NATIONAL_ID request applies to User.idNumber', async (t) => {
	const { adminAffiliateRequestsService, userUpdateSpy } = await loadService(t, {
		request: { id: 'req-3', affiliateProfileId: 'aff-1', fieldType: 'NATIONAL_ID', fieldLabel: 'رقم الهوية الوطنية', requestedValue: '2000000000', currentValue: '1000000000', status: 'PENDING_HUMAN_APPROVAL', requestNumber: 'REQ-3' }
	});

	await adminAffiliateRequestsService.approve('req-3', 'admin-1');
	assert.equal(userUpdateSpy.mock.calls[0].arguments[0].data.idNumber, '2000000000');
});

test('approve: IBAN request applies to AffiliateProfile.iban, never touches User', async (t) => {
	const { adminAffiliateRequestsService, affiliateUpdateSpy, userUpdateSpy } = await loadService(t, {
		request: { id: 'req-4', affiliateProfileId: 'aff-1', fieldType: 'IBAN', fieldLabel: 'IBAN', requestedValue: 'SA0311000000000000000001', currentValue: null, status: 'PENDING_AI_REVIEW', requestNumber: 'REQ-4' }
	});

	await adminAffiliateRequestsService.approve('req-4', 'admin-1');
	assert.equal(affiliateUpdateSpy.mock.calls[0].arguments[0].data.iban, 'SA0311000000000000000001');
	assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('approve: BANK_NAME request applies to AffiliateProfile.bankName', async (t) => {
	const { adminAffiliateRequestsService, affiliateUpdateSpy } = await loadService(t, {
		request: { id: 'req-x', affiliateProfileId: 'aff-1', fieldType: 'BANK_NAME', fieldLabel: 'اسم البنك', requestedValue: 'بنك الرياض', currentValue: null, status: 'PENDING_AI_REVIEW', requestNumber: 'REQ-X' }
	});

	await adminAffiliateRequestsService.approve('req-x', 'admin-1');
	assert.equal(affiliateUpdateSpy.mock.calls[0].arguments[0].data.bankName, 'بنك الرياض');
});

test('approve: ACCOUNT_HOLDER_NAME request applies to AffiliateProfile.accountHolderName', async (t) => {
	const { adminAffiliateRequestsService, affiliateUpdateSpy } = await loadService(t, {
		request: { id: 'req-y', affiliateProfileId: 'aff-1', fieldType: 'ACCOUNT_HOLDER_NAME', fieldLabel: 'اسم صاحب الحساب', requestedValue: 'Amr Okasha', currentValue: null, status: 'PENDING_AI_REVIEW', requestNumber: 'REQ-Y' }
	});

	await adminAffiliateRequestsService.approve('req-y', 'admin-1');
	assert.equal(affiliateUpdateSpy.mock.calls[0].arguments[0].data.accountHolderName, 'Amr Okasha');
});

test('approve: SWIFT_CODE request applies to AffiliateProfile.swiftCode', async (t) => {
	const { adminAffiliateRequestsService, affiliateUpdateSpy } = await loadService(t, {
		request: { id: 'req-z', affiliateProfileId: 'aff-1', fieldType: 'SWIFT_CODE', fieldLabel: 'رمز السويفت', requestedValue: 'RIBLSARI', currentValue: null, status: 'PENDING_AI_REVIEW', requestNumber: 'REQ-Z' }
	});

	await adminAffiliateRequestsService.approve('req-z', 'admin-1');
	assert.equal(affiliateUpdateSpy.mock.calls[0].arguments[0].data.swiftCode, 'RIBLSARI');
});

test('reject: does not modify the real field, only sets status + rejectionReason + reviewer', async (t) => {
	const { adminAffiliateRequestsService, userUpdateSpy, affiliateUpdateSpy, notifySpy } = await loadService(t);

	const result = await adminAffiliateRequestsService.reject('req-1', 'admin-1', 'بيانات غير مطابقة للهوية');

	assert.equal(userUpdateSpy.mock.callCount(), 0);
	assert.equal(affiliateUpdateSpy.mock.callCount(), 0);
	assert.equal(result.status, 'REJECTED');
	assert.equal(result.rejectionReason, 'بيانات غير مطابقة للهوية');
	assert.equal(result.reviewedBy, 'admin-1');
	assert.equal(notifySpy.mock.callCount(), 1);
});

test('approve: an already-finalized (APPROVED_AND_APPLIED) request cannot be approved again', async (t) => {
	const { adminAffiliateRequestsService, userUpdateSpy } = await loadService(t, {
		request: { id: 'req-1', affiliateProfileId: 'aff-1', fieldType: 'EMAIL', fieldLabel: 'x', requestedValue: 'y', currentValue: 'z', status: 'APPROVED_AND_APPLIED', requestNumber: 'REQ-1' }
	});

	await assert.rejects(() => adminAffiliateRequestsService.approve('req-1', 'admin-1'), (error: any) => error.statusCode === 409);
	assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('approve: a REJECTED request cannot be approved after the fact', async (t) => {
	const { adminAffiliateRequestsService } = await loadService(t, {
		request: { id: 'req-1', affiliateProfileId: 'aff-1', fieldType: 'EMAIL', fieldLabel: 'x', requestedValue: 'y', currentValue: 'z', status: 'REJECTED', requestNumber: 'REQ-1' }
	});

	await assert.rejects(() => adminAffiliateRequestsService.approve('req-1', 'admin-1'));
});

test('approve: a WITHDRAWN request cannot be approved', async (t) => {
	const { adminAffiliateRequestsService, userUpdateSpy } = await loadService(t, {
		request: { id: 'req-1', affiliateProfileId: 'aff-1', fieldType: 'EMAIL', fieldLabel: 'x', requestedValue: 'y', currentValue: 'z', status: 'WITHDRAWN', requestNumber: 'REQ-1' }
	});

	await assert.rejects(() => adminAffiliateRequestsService.approve('req-1', 'admin-1'), (error: any) => error.statusCode === 409);
	assert.equal(userUpdateSpy.mock.callCount(), 0);
});

test('reject: an already-finalized request cannot be rejected again', async (t) => {
	const { adminAffiliateRequestsService } = await loadService(t, {
		request: { id: 'req-1', affiliateProfileId: 'aff-1', fieldType: 'EMAIL', fieldLabel: 'x', requestedValue: 'y', currentValue: 'z', status: 'REJECTED', requestNumber: 'REQ-1' }
	});

	await assert.rejects(() => adminAffiliateRequestsService.reject('req-1', 'admin-1', 'سبب'), (error: any) => error.statusCode === 409);
});

test('listRequests: with no status filter, only pending statuses are queried by default', async (t) => {
	let capturedWhere: any = null;
	const prismaMock: any = {
		profileChangeRequest: {
			findMany: async (args: any) => { capturedWhere = args.where; return []; }
		}
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async () => ({}) } } });

	const moduleUrl = `./admin-affiliate-requests.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { adminAffiliateRequestsService } = await import(moduleUrl);

	await adminAffiliateRequestsService.listRequests();
	assert.deepEqual(capturedWhere.status.in.sort(), ['PENDING_AI_REVIEW', 'PENDING_HUMAN_APPROVAL']);
});

test('listRequests: an explicit status filter is honored', async (t) => {
	let capturedWhere: any = null;
	const prismaMock: any = {
		profileChangeRequest: {
			findMany: async (args: any) => { capturedWhere = args.where; return []; }
		}
	};
	t.mock.module('../config/db', { namedExports: { prisma: prismaMock } });
	t.mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async () => ({}) } } });

	const moduleUrl = `./admin-affiliate-requests.service.ts?fixture=${Date.now()}-${Math.random()}`;
	const { adminAffiliateRequestsService } = await import(moduleUrl);

	await adminAffiliateRequestsService.listRequests('REJECTED');
	assert.equal(capturedWhere.status, 'REJECTED');
});
