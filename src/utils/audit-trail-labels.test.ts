import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { auditActionLabel, AUDIT_ACTION_LABELS, accessActionSeverity } from './audit-trail-labels';
import { accessDetail, actorIdOfLog, logDetail } from '../services/admin-audit-trail.service';

function sources(dir: string, out: string[] = []): string[] {
	for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, f.name);
		if (f.isDirectory()) sources(p, out); else if (/\.ts$/.test(f.name) && !/\.(test|spec|pgenv)\./.test(f.name) && !p.includes('/testing/')) out.push(p);
	}
	return out;
}

test('every audit event code the platform writes has an Arabic name (a new code must be added to audit-trail-labels, otherwise it would show as a bare code)', () => {
	const codes = new Set<string>();
	for (const f of sources(path.join(__dirname, '..'))) {
		const txt = fs.readFileSync(f, 'utf8');
		for (const m of txt.matchAll(/(?:eventType|action):\s*'([A-Z][A-Z0-9_]+)'/g)) codes.add(m[1]);
	}
	assert.ok(codes.size > 40, `scanned ${codes.size} codes`);
	const writers = [...codes].filter(c => /_/.test(c) || AUDIT_ACTION_LABELS[c]);
	const missing = writers.filter(c => !AUDIT_ACTION_LABELS[c] && /^(SESSION|ROLE|INVITE|STAFF|TICKET|DISPUTE|WITHDRAWAL|FEE_POLICY|PLATFORM|KYC|LOGIN|PASSWORD|OTP|PROFILE|CATEGORY|SPECIALTY|MARKETER|ACCREDITATION|ADMIN|USER|FINANCE|MARKETING|PAYPAL|SENSITIVE)_/.test(c));
	assert.deepEqual(missing, []);
});

test('an unknown code is shown as the code itself; known codes have distinct names', () => {
	assert.equal(auditActionLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
	assert.equal(auditActionLabel('SESSION_STARTED'), 'تسجيل دخول جديد');
	const names = Object.values(AUDIT_ACTION_LABELS); assert.equal(new Set(names).size, names.length, 'no two codes share a name');
	assert.equal(accessActionSeverity('STAFF_SUSPENDED'), 'WARNING'); assert.equal(accessActionSeverity('ROLE_CREATED'), 'INFO');
});

test('actor of a log row: the admin named in actorLabel / metaData for rows kept on the affected account, otherwise the owner of the row', () => {
	const admin = '11111111-1111-4111-8111-111111111111';
	assert.equal(actorIdOfLog({ userId: 'u', actorLabel: `ADMIN:${admin}` }), admin);
	assert.equal(actorIdOfLog({ userId: 'u', actorLabel: `SUPER_ADMIN:${admin}` }), admin);
	assert.equal(actorIdOfLog({ userId: 'u', actorLabel: 'x', metaData: { adminId: admin } }), admin);
	assert.equal(actorIdOfLog({ userId: 'u', actorLabel: 'ADMIN' }), 'u');
	assert.equal(actorIdOfLog({ userId: 'u', actorLabel: null }), 'u');
});

test('details are built from stored metadata only: settings by label, fee policy version + count with the date kept separate, access trail from before/after', () => {
	assert.deepEqual(logDetail({ eventType: 'PLATFORM_SETTINGS_UPDATED', metaData: { keys: ['maintenanceMode'] } }).detail?.startsWith('الإعدادات: '), true);
	const fee = logDetail({ eventType: 'FEE_POLICY_SCHEDULED', summary: 'نسخة 3 تسري من 2026-10-30T00:00:00.000Z: 1 تغيير', metaData: { version: 3, effectiveFrom: '2026-10-30T00:00:00.000Z' }, afterData: { minProviderPayout: 25 } });
	assert.equal(fee.detail, 'نسخة 3 · 1 تغيير · تسري من'); assert.equal(fee.detailDate, '2026-10-30T00:00:00.000Z'); assert.ok(!/2026/.test(fee.detail!));
	assert.equal(logDetail({ eventType: 'SESSION_STARTED', summary: 'بدأت جلسة جديدة' }).detail, 'بدأت جلسة جديدة');
	assert.equal(logDetail({ eventType: 'SESSION_STARTED' }).detail, null);
	const names = new Map([['r1', 'مالية'], ['r2', 'دعم']]); const rn = (id: unknown) => names.get(String(id)) ?? null;
	assert.equal(accessDetail({ action: 'STAFF_ROLE_SET', before: { roleId: 'r1' }, after: { roleId: 'r2' } }, rn), 'من «مالية» إلى «دعم»');
	assert.equal(accessDetail({ action: 'STAFF_ROLE_SET', before: { roleId: null }, after: { roleId: 'r2' } }, rn), 'من «بلا دور» إلى «دعم»');
	assert.equal(accessDetail({ action: 'ROLE_UPDATED', before: { name: 'أ' }, after: { name: 'ب', permissionsAdded: ['x', 'y'], permissionsRemoved: [] } }, rn), 'الاسم من «أ» إلى «ب» · أُضيفت 2 وأُزيلت 0 صلاحية');
	assert.equal(accessDetail({ action: 'STAFF_SUSPENDED', before: { status: 'ACTIVE' }, after: { status: 'SUSPENDED' } }, rn), 'الحالة: نشط ← موقوف');
	assert.equal(accessDetail({ action: 'UNKNOWN_X' }, rn), null);
});
