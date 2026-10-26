import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AUDIT_CLASSES, ALL_CLASSIFIED_CODES, GENERIC_FALLBACK_CODES, classifiedSeverity, effectiveSeverity } from './audit-trail-classification';
import { AUDIT_ACTION_LABELS, ACCESS_ACTION_CODES, SELF_ACTED_CODES, auditActionLabel } from './audit-trail-labels';

function sources(dir: string, out: string[] = []): string[] {
	for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, f.name);
		if (f.isDirectory()) sources(p, out); else if (/\.ts$/.test(f.name) && !/\.(test|spec|pgenv)\./.test(f.name) && !p.includes('/testing/')) out.push(p);
	}
	return out;
}
/** UPPER_SNAKE words that appear next to `eventType` / `action` in src but are NOT audit event codes (categories, enum values, request actions) */
const NOT_EVENT_CODES = new Set(['REFUND_CLIENT', 'SYSTEM_AUDIT', 'SECURITY_CHANGE', 'PROFILE_COMPLETION', 'IN_REVIEW', 'WRONG_ROLE', 'ACTIVE_DISPUTE_FREEZE', 'UNDER_REVIEW', 'IN_PROGRESS', 'REVISION_REQUESTED', 'UNDER_AI_REVIEW', 'PASSWORD_RESET']);
const writtenCodes = () => {
	const codes = new Map<string, string>();
	for (const f of sources(path.join(__dirname, '..'))) {
		const txt = fs.readFileSync(f, 'utf8');
		for (const m of txt.matchAll(/\b(?:eventType|action)\b\s*[:=][^;]{0,400}/g)) for (const t of m[0].matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)) codes.set(t[1], path.relative(path.join(__dirname, '..'), f));
	}
	return codes;
};

test('EVERY audit event code written anywhere in src has a severity class (or is a documented generic fallback); a new code must be classified', () => {
	const codes = writtenCodes();
	assert.ok(codes.size > 60, `scanned ${codes.size} codes`);
	const missing = [...codes.keys()].filter(c => !NOT_EVENT_CODES.has(c) && !classifiedSeverity(c) && !GENERIC_FALLBACK_CODES.includes(c));
	assert.deepEqual(missing, [], `classify these in utils/audit-trail-classification.ts: ${missing.join(', ')}`);
	// the template-built code MARKETPLACE_SERVICE_${action} and the access-trail codes are covered explicitly
	for (const c of ['MARKETPLACE_SERVICE_APPROVE', 'MARKETPLACE_SERVICE_REJECT', 'MARKETPLACE_SERVICE_HIDE', 'PAYPAL_EMAIL_CHANGED', ...ACCESS_ACTION_CODES]) assert.ok(classifiedSeverity(c), c);
});

test('the table is consistent: a code is in exactly one class, every class has a reason, every classified code has an Arabic name', () => {
	const seen = new Set<string>();
	for (const c of AUDIT_CLASSES) { assert.ok(c.reason.length > 10, c.id); for (const code of c.codes) { assert.ok(!seen.has(code), `duplicate ${code}`); seen.add(code); } }
	assert.equal(seen.size, ALL_CLASSIFIED_CODES.length);
	assert.deepEqual(ALL_CLASSIFIED_CODES.filter(c => !AUDIT_ACTION_LABELS[c]), []);
	for (const c of SELF_ACTED_CODES) assert.ok(classifiedSeverity(c), `self-acted code ${c} must be classified`);
});

test('natures: deletion / payout / financial resolution CRITICAL; suspension, roles, settings, fee policy, failed logins, finance WARNING; sessions INFO', () => {
	for (const c of ['USER_DELETED_BY_ADMIN', 'WITHDRAWAL_PAYOUT_SENT', 'DISPUTE_FINANCIAL_RESOLVED']) assert.equal(classifiedSeverity(c), 'CRITICAL', c);
	for (const c of ['STAFF_SUSPENDED', 'ACCOUNT_SUSPENDED_BY_ADMIN', 'ROLE_UPDATED', 'STAFF_ROLE_SET', 'PLATFORM_SETTINGS_UPDATED', 'FEE_POLICY_SCHEDULED', 'LOGIN_REJECTED', 'WITHDRAWAL_APPROVED', 'FINANCE_EXPORT', 'CATEGORY_DELETED', 'KYC_DOCUMENT_VIEWED_BY_ADMIN']) assert.equal(classifiedSeverity(c), 'WARNING', c);
	for (const c of ['SESSION_STARTED', 'TICKET_REPLIED', 'ROLE_CREATED'.replace('ROLE_CREATED', 'INVITE_RESENT')]) assert.equal(classifiedSeverity(c), 'INFO', c);
});

test('effective severity: stored WARNING / CRITICAL is honoured, a stored INFO never lowers a class, an unlisted code is UNCLASSIFIED (never guessed)', () => {
	assert.deepEqual(effectiveSeverity('SESSION_STARTED', 'INFO'), { severity: 'INFO', source: 'classification' });
	assert.deepEqual(effectiveSeverity('STAFF_SUSPENDED', 'INFO'), { severity: 'WARNING', source: 'classification' });
	assert.deepEqual(effectiveSeverity('SESSION_STARTED', 'WARNING'), { severity: 'WARNING', source: 'stored' });
	assert.deepEqual(effectiveSeverity('LOGIN_REJECTED', 'CRITICAL'), { severity: 'CRITICAL', source: 'stored' });
	assert.deepEqual(effectiveSeverity('USER_DELETED_BY_ADMIN', 'WARNING'), { severity: 'CRITICAL', source: 'classification' });
	assert.deepEqual(effectiveSeverity('SOMETHING_NEW', 'INFO'), { severity: 'UNCLASSIFIED', source: 'none' });
	assert.deepEqual(effectiveSeverity('SOMETHING_NEW', null), { severity: 'UNCLASSIFIED', source: 'none' });
	assert.deepEqual(effectiveSeverity('SYSTEM_EVENT', 'INFO'), { severity: 'UNCLASSIFIED', source: 'none' });
	assert.deepEqual(effectiveSeverity('SOMETHING_NEW', 'WARNING'), { severity: 'WARNING', source: 'stored' });
});

test('an unknown code is shown as the code itself; known codes have distinct names', () => {
	assert.equal(auditActionLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
	assert.equal(auditActionLabel('SESSION_STARTED'), 'تسجيل دخول جديد');
	const names = Object.values(AUDIT_ACTION_LABELS); assert.equal(new Set(names).size, names.length, 'no two codes share a name');
});
