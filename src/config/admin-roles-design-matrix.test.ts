import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_ROLE_TEMPLATES, ADMIN_PERMISSION_IDS, SUPER_ADMIN_ONLY_CAPABILITIES } from './admin-permissions';

// P-AD-024 matrix, copied from the design file (columns: Super Admin, مدير فريق, مشرف نزاعات, مشرف دعم, مشرف محتوى, مشرف مالي). The row -> permission id mapping is the only interpretation.
const DESIGN: Array<{ row: string; id: string | null; cols: number[] }> = [
	{ row: 'عرض المستخدمين', id: 'users.view', cols: [1, 1, 1, 1, 0, 0] },
	{ row: 'تعليق المستخدمين', id: 'users.suspend', cols: [1, 1, 1, 0, 0, 0] },
	{ row: 'حذف الحسابات', id: 'users.delete', cols: [1, 0, 0, 0, 0, 0] },
	{ row: 'حل النزاعات', id: 'disputes.resolve', cols: [1, 1, 1, 0, 0, 0] },
	{ row: 'عرض البلاغات', id: 'reports.view', cols: [1, 1, 1, 1, 0, 0] },
	{ row: 'مراجعة الدعم', id: 'support.review', cols: [1, 1, 0, 1, 0, 0] },
	{ row: 'اعتماد التخصصات', id: 'specialties.approve', cols: [1, 1, 0, 0, 1, 0] },
	{ row: 'تعديل الباقات', id: 'packages.manage', cols: [1, 1, 0, 0, 0, 0] },
	{ row: 'الموافقة على السحوبات', id: 'withdrawals.approve', cols: [1, 1, 0, 0, 0, 1] },
	{ row: 'عرض التقارير المالية', id: 'finance.read', cols: [1, 1, 0, 0, 0, 1] },
	{ row: 'إدارة الصلاحيات', id: null, cols: [1, 0, 0, 0, 0, 0] }, // SUPER_ADMIN only, not a permission
	{ row: 'Audit Trail', id: 'audit.view', cols: [1, 0, 0, 0, 0, 0] },
	{ row: 'تعديل الإعدادات', id: 'settings.manage', cols: [1, 0, 0, 0, 0, 0] },
];
const COLUMN_NAMES = ['Super Admin', 'مدير فريق', 'مشرف نزاعات', 'مشرف دعم', 'مشرف محتوى', 'مشرف مالي'];
// what a role needs in addition to the design row to be usable (reading the thing it acts on, or the team pages); never an action the design row does not show
// messages.use: the owner's decision of 2026-10-25 - internal messaging for all five base roles (no read of others' conversations, nothing operational)
const SUPPORTING = new Set(['disputes.view', 'withdrawals.review', 'team.view', 'tasks.manage', 'messages.use']);
// functional decision of the decision-maker (2026-10-25): «مراجعة الدعم» of the design means PROCESSING tickets, so the support supervisor also holds support.reply (reply, status, priority, internal notes, taking a ticket for himself)
const FUNCTIONAL = new Map<string, string[]>([['مشرف دعم', ['support.reply']]]);

test('the five job roles are exactly the design\'s columns (names, and nothing but them), Super Admin is the account type', () => {
	assert.deepEqual(ADMIN_ROLE_TEMPLATES.map(t => t.name), COLUMN_NAMES.slice(1));
	assert.ok(!ADMIN_ROLE_TEMPLATES.some(t => /super|مدير النظام/i.test(t.name)), 'no job role is called Super Admin / مدير النظام');
});

test('every template grants EXACTLY the design matrix of its column (plus only supporting read / team ids); no row of «إدارة الصلاحيات» is a grantable permission', () => {
	for (const [i, t] of ADMIN_ROLE_TEMPLATES.entries()) {
		const col = i + 1; const mapped = new Set(DESIGN.map(r => r.id).filter(Boolean) as string[]);
		for (const r of DESIGN) {
			if (!r.id) { assert.equal(r.cols[col], 0, `${t.name}: ${r.row} is Super Admin only`); continue; }
			assert.equal(t.permissions.includes(r.id), r.cols[col] === 1, `${t.name} / ${r.row} (${r.id})`);
		}
		for (const p of t.permissions) assert.ok(mapped.has(p) || SUPPORTING.has(p) || (FUNCTIONAL.get(t.name) ?? []).includes(p), `${t.name} holds ${p}, which is not a design row, a supporting id nor a recorded functional decision`);
	}
	assert.equal(DESIGN.find(r => r.row === 'إدارة الصلاحيات')!.cols.slice(1).every(x => x === 0), true);
	for (const c of SUPER_ADMIN_ONLY_CAPABILITIES) assert.ok(!ADMIN_PERMISSION_IDS.includes(c));
});

test('reading never carries approval or payout, and no job role carries money-moving ids beyond the design (approve yes only where the design says; reject / payout never from a template)', () => {
	for (const t of ADMIN_ROLE_TEMPLATES) {
		for (const never of ['payouts.send', 'withdrawals.reject', 'users.delete', 'settings.manage', 'audit.view', 'site_control.manage', 'site.view', 'site.manage', 'marketing_assets.manage', 'performance.export']) assert.ok(!t.permissions.includes(never), `${t.name} must not carry ${never}`);
		if (t.permissions.includes('withdrawals.review') && !t.permissions.includes('withdrawals.approve')) assert.fail(`${t.name}: review without approve is a read role only: fine, but not in the design`);
	}
	// the support supervisor processes tickets (decision 2026-10-25) but gets no team distribution, no people management, no money and no dispute resolution
	const support = ADMIN_ROLE_TEMPLATES.find(t => t.name === 'مشرف دعم')!; assert.ok(support.permissions.includes('support.review') && support.permissions.includes('support.reply'));
	for (const never of ['tasks.manage', 'team.view', 'disputes.resolve', 'withdrawals.approve', 'payouts.send', 'users.suspend', 'users.delete']) assert.ok(!support.permissions.includes(never), never);
	// the team manager distributes tasks but holds nothing that manages roles / permissions / staff (those are not permissions at all)
	const tm = ADMIN_ROLE_TEMPLATES.find(t => t.name === 'مدير فريق')!; assert.ok(tm.permissions.includes('tasks.manage') && tm.permissions.includes('team.view'));
});
