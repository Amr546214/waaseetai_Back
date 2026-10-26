import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorOfLog, logTarget, logDetail, accessDetail } from './admin-audit-trail.service';

const A = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222';
const users = new Map([[U, { id: U, name: 'نورة', accountType: 'CLIENT_INDIVIDUAL' }], [A, { id: A, name: 'سارة', accountType: 'ADMIN' }]]);
const tgt = (r: any) => logTarget({ userId: U, ...r }, actorOfLog({ userId: U, ...r }), users);

test('actor: every row layout proves its actor, or the actor is unknown (never the row owner by guess)', () => {
	// back-office rows written on the affected account (adminAuditData / human review / bare id label)
	assert.deepEqual(actorOfLog({ userId: U, eventType: 'KYC_APPROVED_BY_ADMIN', source: 'ADMIN', actorLabel: `ADMIN:${A}` }), { id: A, kind: 'USER' });
	assert.deepEqual(actorOfLog({ userId: U, eventType: 'HUMAN_REVIEW_COMPLETED', source: 'ADMIN', actorLabel: A }), { id: A, kind: 'USER' });
	// admin kept in the metadata
	for (const [code, key] of [['BROKER_SUSPENDED', 'adminId'], ['MARKETER_KYC_APPROVED', 'reviewerUserId'], ['KYC_DOCUMENT_VIEWED_BY_ADMIN', 'viewerUserId'], ['AMENDMENT_APPLIED', 'appliedById']] as const)
		assert.deepEqual(actorOfLog({ userId: U, eventType: code, source: 'ADMIN', metaData: { [key]: A } }), { id: A, kind: 'USER' }, code);
	// rows owned by the acting admin: entity rows, settings / fee policy
	assert.deepEqual(actorOfLog({ userId: A, eventType: 'DISPUTE_ASSIGNED', source: 'ADMIN', context: { entity: 'DISPUTE', entityId: 'd1' } }), { id: A, kind: 'USER' });
	assert.deepEqual(actorOfLog({ userId: A, eventType: 'PLATFORM_SETTINGS_UPDATED', source: 'ADMIN', actorLabel: 'ADMIN' }), { id: A, kind: 'USER' });
	assert.deepEqual(actorOfLog({ userId: A, eventType: 'FEE_POLICY_SCHEDULED', source: 'ADMIN' }), { id: A, kind: 'USER' });
	// own-account events
	assert.deepEqual(actorOfLog({ userId: A, eventType: 'SESSION_STARTED', source: 'USER' }), { id: A, kind: 'USER' });
	assert.deepEqual(actorOfLog({ userId: A, eventType: 'PASSWORD_CHANGED', source: null }), { id: A, kind: 'USER' });
	// NOT proven: failed login, an old ADMIN row with no actor trace, a user row of a non-self code, a SELF code written by ADMIN
	assert.deepEqual(actorOfLog({ userId: U, eventType: 'LOGIN_REJECTED', source: 'USER' }), { id: null, kind: 'UNKNOWN' });
	assert.deepEqual(actorOfLog({ userId: U, eventType: 'KYC_APPROVED_BY_ADMIN', source: 'ADMIN' }), { id: null, kind: 'UNKNOWN' });
	assert.deepEqual(actorOfLog({ userId: U, eventType: 'STAGE_FUND_RELEASED', source: 'USER' }), { id: null, kind: 'UNKNOWN' });
	assert.deepEqual(actorOfLog({ userId: U, eventType: 'SESSION_STARTED', source: 'ADMIN' }), { id: null, kind: 'UNKNOWN' });
	assert.deepEqual(actorOfLog({ userId: U, eventType: 'X', source: 'SYSTEM' }), { id: null, kind: 'SYSTEM' });
	assert.deepEqual(actorOfLog({ userId: U, eventType: 'X', source: 'AI' }), { id: null, kind: 'AI' });
	// a label that is not an id proves nothing
	assert.deepEqual(actorOfLog({ userId: U, eventType: 'KYC_APPROVED_BY_ADMIN', source: 'ADMIN', actorLabel: 'someone@x.test' }), { id: null, kind: 'UNKNOWN' });
});

test('target per event type: back-office actions point at the affected account, entity rows at their entity, settings / fee policy / coupon / contract / deleted user at their own', () => {
	const admin = { source: 'ADMIN', actorLabel: `ADMIN:${A}` };
	for (const code of ['KYC_APPROVED_BY_ADMIN', 'KYC_REJECTED_BY_ADMIN', 'ACCOUNT_SUSPENDED_BY_ADMIN', 'ACCOUNT_ACTIVATED_BY_ADMIN', 'ROLES_CHANGED_BY_ADMIN', 'ADMIN_MESSAGE_SENT', 'ACCREDITATION_APPROVED_BY_ADMIN', 'ACCREDITATION_REJECTED_BY_ADMIN', 'ACCREDITATION_COMPLETION_REQUESTED'])
		assert.deepEqual(tgt({ eventType: code, ...admin }), { type: 'USER', typeLabel: 'حساب', id: U, label: 'نورة' }, code);
	for (const [code, meta] of [['BROKER_SUSPENDED', { adminId: A }], ['BROKER_REACTIVATED', { adminId: A }], ['SPECIALTY_ADMIN_DECISION', { adminId: A }], ['MARKETER_KYC_APPROVED', { reviewerUserId: A }], ['MARKETER_KYC_REJECTED', { reviewerUserId: A }], ['KYC_DOCUMENT_VIEWED_BY_ADMIN', { viewerUserId: A }], ['HUMAN_REVIEW_COMPLETED', { adminId: A }]] as const)
		assert.equal(tgt({ eventType: code, source: 'ADMIN', metaData: meta })?.id, U, code);
	// the deleted account is in the metadata (the row is owned by the deleting admin)
	assert.deepEqual(logTarget({ userId: A, eventType: 'USER_DELETED_BY_ADMIN', source: 'ADMIN', actorLabel: `SUPER_ADMIN:${A}`, metaData: { adminId: A, deletedUserId: U } }, { id: A, kind: 'USER' }, users), { type: 'USER', typeLabel: 'حساب', id: U, label: null });
	assert.deepEqual(logTarget({ userId: A, eventType: 'COUPON_ADMIN_DEACTIVATED', source: 'ADMIN', metaData: { adminId: A, couponId: 'c1', code: 'SAVE10' } }, { id: A, kind: 'USER' }, users), { type: 'COUPON', typeLabel: 'كوبون', id: 'c1', label: 'SAVE10' });
	for (const [code, entity, typeLabel] of [['DISPUTE_ASSIGNED', 'DISPUTE', 'نزاع'], ['TICKET_REPLIED', 'TICKET', 'تذكرة'], ['WITHDRAWAL_APPROVED', 'WITHDRAWAL', 'طلب سحب'], ['DISPUTE_FINANCIAL_RESOLVED', 'DISPUTE', 'نزاع'], ['FINANCE_EXPORT', 'FINANCE', 'مالية']] as const)
		assert.deepEqual(logTarget({ userId: A, eventType: code, source: 'ADMIN', context: { entity, entityId: 'e1' } }, { id: A, kind: 'USER' }, users), { type: entity, typeLabel, id: 'e1', label: null }, code);
	assert.equal(logTarget({ userId: A, eventType: 'PLATFORM_SETTINGS_UPDATED', source: 'ADMIN', actorLabel: 'ADMIN' }, { id: A, kind: 'USER' }, users)?.type, 'SETTINGS');
	assert.equal(logTarget({ userId: A, eventType: 'FEE_POLICY_CANCELLED', source: 'ADMIN', actorLabel: 'ADMIN', metaData: { version: 4 } }, { id: A, kind: 'USER' }, users)?.label, 'نسخة 4');
	assert.deepEqual(logTarget({ userId: U, eventType: 'AMENDMENT_APPLIED', source: 'USER', metaData: { appliedById: U, contractId: 'k1' } }, { id: U, kind: 'USER' }, users), { type: 'CONTRACT', typeLabel: 'عقد', id: 'k1', label: null });
	// own-account events have no target; a failed login targets the account but names no actor
	assert.equal(logTarget({ userId: A, eventType: 'SESSION_STARTED', source: 'USER' }, { id: A, kind: 'USER' }, users), null);
	assert.equal(tgt({ eventType: 'LOGIN_REJECTED', source: 'USER' })?.id, U);
});

test('details come from allow-listed metadata and stored sentences, always redacted', () => {
	assert.equal(logDetail({ eventType: 'SESSION_STARTED', summary: 'بدأت جلسة جديدة' }).detail, 'بدأت جلسة جديدة');
	assert.equal(logDetail({ eventType: 'WALLET_DEPOSIT_COMPLETED', summary: 'تم شحن المحفظة بمبلغ 50.00 دولار - رقم عملية PayPal: 5TY05013RG002845M' }).detail?.includes('5TY05013RG002845M'), false);
	assert.equal(logDetail({ eventType: 'KYC_APPROVED_BY_ADMIN', summary: null, metaData: { adminId: A, password: 'x', reason: 'مطابق' } }).detail, 'السبب: مطابق');
	assert.equal(logDetail({ eventType: 'Y' }).detail, null);
	const fee = logDetail({ eventType: 'FEE_POLICY_SCHEDULED', summary: 'نسخة 3 تسري من 2026-10-30T00:00:00.000Z: 1 تغيير', metaData: { version: 3, effectiveFrom: '2026-10-30T00:00:00.000Z' }, afterData: { minProviderPayout: 25 } });
	assert.equal(fee.detail, 'نسخة 3 · 1 تغيير · تسري من'); assert.equal(fee.detailDate, '2026-10-30T00:00:00.000Z');
	const rn = (id: unknown) => ({ r1: 'مالية', r2: 'دعم' } as any)[String(id)] ?? null;
	assert.equal(accessDetail({ action: 'STAFF_ROLE_SET', before: { roleId: 'r1' }, after: { roleId: 'r2' } }, rn), 'من «مالية» إلى «دعم»');
	assert.equal(accessDetail({ action: 'STAFF_SUSPENDED', before: { status: 'ACTIVE' }, after: { status: 'SUSPENDED' } }, rn), 'الحالة: نشط ← موقوف');
	assert.equal(accessDetail({ action: 'UNKNOWN_X' }, rn), null);
});

test('site identity codes: the acting admin is proven, the target is the identity key (Arabic label), the detail names the versions only', () => {
	for (const code of ['SITE_IDENTITY_UPLOADED', 'SITE_IDENTITY_PUBLISHED', 'SITE_IDENTITY_RESTORED', 'SITE_IDENTITY_SET_RESTORED', 'SITE_IDENTITY_DISCARDED']) assert.deepEqual(actorOfLog({ userId: A, eventType: code, source: 'ADMIN' }), { id: A, kind: 'USER' }, code);
	const t = logTarget({ userId: A, eventType: 'SITE_IDENTITY_PUBLISHED', source: 'ADMIN', actorLabel: 'ADMIN', metaData: { identityKey: 'icon.ai' } }, { id: A, kind: 'USER' }, users);
	assert.deepEqual(t, { type: 'SITE_IDENTITY', typeLabel: 'هوية الموقع', id: 'icon.ai', label: 'أيقونة الذكاء الاصطناعي' });
	assert.equal(logTarget({ userId: A, eventType: 'SITE_IDENTITY_SET_RESTORED', source: 'ADMIN', actorLabel: 'ADMIN', metaData: { identityKey: 'icon.ai,logo.mark' } }, { id: A, kind: 'USER' }, users)?.id, null);
	assert.equal(logDetail({ eventType: 'SITE_IDENTITY_PUBLISHED', metaData: { identityKey: 'logo.mark', fromVersion: 0, toVersion: 2 } }).detail, 'شعار وسيط AI (العلامة) · الافتراضي ← نسخة 2');
	assert.equal(logDetail({ eventType: 'SITE_IDENTITY_RESTORED', metaData: { identityKey: 'logo.mark', fromVersion: 2, toVersion: 0 } }).detail, 'شعار وسيط AI (العلامة) · نسخة 2 ← الافتراضي');
	assert.equal(logDetail({ eventType: 'SITE_IDENTITY_UPLOADED', metaData: { identityKey: 'logo.mark', version: 3, sha: 'abcdef012345' } }).detail, 'شعار وسيط AI (العلامة) · مسودة نسخة 3 · abcdef012345');
	assert.equal(logDetail({ eventType: 'SITE_IDENTITY_SET_RESTORED', metaData: { identityKey: 'icon.ai,logo.mark', target: 'manifest 4' } }).detail, 'manifest 4 · 2 عنصر');
});
