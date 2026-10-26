/**
 * The ONE registry of admin permissions. Every admin endpoint is bound to an id from here (see src/middlewares/admin-access.middleware.ts); the server never decides from a role NAME,
 * from the account type (ADMIN / SUPER_ADMIN grant nothing by themselves) or from anything the browser says.
 *
 * Source of the list: the decision of 2026-10-25 (the fine-grained list in the task) read against the permission matrix of the design page P-AD-024 (13 rows x 6 roles).
 * Nothing here is invented beyond that: where the two differ it is noted in AMBIGUITIES and the SUPER_ADMIN decides. The ids are stable (stored in roles and in the audit trail): never rename one.
 *
 * SUPER_ADMIN-only capabilities are NOT permissions and cannot be granted to anybody (not by a role, not by a per-person grant): inviting staff, creating / editing roles, granting /
 * withdrawing permissions, suspending / reactivating staff. They are exercised through `requireSuperAdmin` only, and the authority comes from the account type read on the server.
 */

export type AdminPermissionGroup =
	| 'users' | 'reports_support' | 'disputes' | 'reviews' | 'content' | 'finance' | 'team' | 'system';

export interface AdminPermissionDef {
	id: string;
	label: string;
	group: AdminPermissionGroup;
	/** shown with a warning before it is granted (money, deletion, system-wide effect) */
	sensitive: boolean;
	/** the row of the design matrix (P-AD-024) this id comes from, when there is one */
	designRow?: string;
}

export const ADMIN_GROUP_LABELS: Record<AdminPermissionGroup, string> = {
	users: 'المستخدمون', reports_support: 'البلاغات والدعم', disputes: 'النزاعات', reviews: 'المراجعات والاعتماد', content: 'المحتوى والباقات',
	finance: 'المالية', team: 'الفريق والمهام', system: 'النظام',
};

export const ADMIN_PERMISSIONS: readonly AdminPermissionDef[] = [
	{ id: 'users.view', label: 'عرض المستخدمين', group: 'users', sensitive: false, designRow: 'عرض المستخدمين' },
	{ id: 'users.suspend', label: 'تعليق المستخدمين', group: 'users', sensitive: true, designRow: 'تعليق المستخدمين' },
	{ id: 'users.delete', label: 'حذف الحسابات', group: 'users', sensitive: true, designRow: 'حذف الحسابات' },

	{ id: 'reports.view', label: 'عرض البلاغات', group: 'reports_support', sensitive: false, designRow: 'عرض البلاغات' },
	{ id: 'support.review', label: 'مراجعة الدعم', group: 'reports_support', sensitive: false, designRow: 'مراجعة الدعم' },
	{ id: 'support.reply', label: 'الرد على الدعم ومعالجة التذكرة', group: 'reports_support', sensitive: false },

	{ id: 'disputes.view', label: 'عرض النزاعات', group: 'disputes', sensitive: false },
	{ id: 'disputes.note', label: 'إضافة ملاحظات النزاع', group: 'disputes', sensitive: false },
	{ id: 'disputes.assign', label: 'إسناد النزاعات', group: 'disputes', sensitive: false },
	{ id: 'disputes.resolve', label: 'حل النزاعات', group: 'disputes', sensitive: true, designRow: 'حل النزاعات' },

	{ id: 'identity.review', label: 'مراجعة الهوية', group: 'reviews', sensitive: false },
	{ id: 'specialties.approve', label: 'اعتماد التخصصات', group: 'reviews', sensitive: false, designRow: 'اعتماد التخصصات' },
	{ id: 'business_models.review', label: 'مراجعة نماذج الأعمال', group: 'reviews', sensitive: false },

	{ id: 'content.manage', label: 'إدارة المحتوى والتخصصات', group: 'content', sensitive: false },
	{ id: 'marketing_assets.manage', label: 'إدارة المواد التسويقية', group: 'content', sensitive: false },
	{ id: 'packages.manage', label: 'تعديل الباقات', group: 'content', sensitive: true, designRow: 'تعديل الباقات' },

	{ id: 'finance.read', label: 'قراءة المالية', group: 'finance', sensitive: false, designRow: 'عرض التقارير المالية' },
	{ id: 'fees.view', label: 'عرض سياسة الرسوم والعمولات', group: 'finance', sensitive: false },
	{ id: 'fees.manage', label: 'جدولة تعديل الرسوم والعمولات والحدود الدنيا', group: 'finance', sensitive: true },
	{ id: 'withdrawals.review', label: 'مراجعة طلبات السحب', group: 'finance', sensitive: false },
	{ id: 'withdrawals.approve', label: 'الموافقة على السحب', group: 'finance', sensitive: true, designRow: 'الموافقة على السحوبات' },
	{ id: 'withdrawals.reject', label: 'رفض السحب', group: 'finance', sensitive: true },
	{ id: 'payouts.send', label: 'إرسال الصرف', group: 'finance', sensitive: true },

	{ id: 'team.view', label: 'عرض الفريق', group: 'team', sensitive: false },
	{ id: 'tasks.manage', label: 'إدارة المهام', group: 'team', sensitive: false },
	{ id: 'performance.view', label: 'عرض الأداء', group: 'team', sensitive: false },
	{ id: 'performance.export', label: 'تصدير الأداء', group: 'team', sensitive: false },
	{ id: 'messages.use', label: 'مراسلة فريق الإدارة', group: 'team', sensitive: false },

	{ id: 'settings.view', label: 'عرض إعدادات النظام', group: 'system', sensitive: false },
	{ id: 'settings.manage', label: 'إعدادات النظام', group: 'system', sensitive: true, designRow: 'تعديل الإعدادات' },
	{ id: 'site_control.manage', label: 'التحكم بالموقع', group: 'system', sensitive: true },
	{ id: 'audit.view', label: 'عرض سجلات التدقيق', group: 'system', sensitive: false, designRow: 'Audit Trail' },
] as const;

/** The department line of a role / member (design: «القسم»): the permission groups its permissions fall in, in registry order. Derived, never typed in, so it can never claim authority the role lacks. */
export const departmentsOf = (ids: readonly string[]): string[] => {
	const held = new Set(ids), seen: AdminPermissionGroup[] = [];
	for (const p of ADMIN_PERMISSIONS) if (held.has(p.id) && !seen.includes(p.group)) seen.push(p.group);
	return seen.map(g => ADMIN_GROUP_LABELS[g]);
};

export const ADMIN_PERMISSION_IDS: readonly string[] = ADMIN_PERMISSIONS.map(p => p.id);
const KNOWN = new Set(ADMIN_PERMISSION_IDS);
export const isKnownPermission = (id: string): boolean => KNOWN.has(id);

/** Capabilities that are not permissions: only a SUPER_ADMIN account has them. */
export const SUPER_ADMIN_ONLY_CAPABILITIES = ['staff.invite', 'staff.role', 'staff.suspend', 'roles.manage', 'permissions.grant', 'super_admin.create'] as const;

/**
 * Starting points a SUPER_ADMIN can pick when creating a role (they are NOT stored roles and nobody holds them). Built ONLY from the design matrix P-AD-024: one design row maps to the
 * ids that carry its name; where the design has a single row for several finer ids the template lists the read-side ids only and says so in `notes`.
 */
export interface AdminRoleTemplate { key: string; name: string; description: string; color: string; permissions: string[]; notes?: string }
export const ADMIN_ROLE_TEMPLATES: readonly AdminRoleTemplate[] = [
	{ key: 'team_manager', name: 'مدير فريق', description: 'يدير الموظفين ويوزع المهام', color: '#D98A0B',
		permissions: ['users.view', 'users.suspend', 'disputes.view', 'disputes.resolve', 'reports.view', 'support.review', 'specialties.approve', 'packages.manage', 'withdrawals.review', 'withdrawals.approve', 'finance.read', 'team.view', 'tasks.manage', 'messages.use'],
		notes: 'العمود في التصميم يضم 9 صفوف؛ بطاقة الدور تذكر 11 صلاحية (تعارض داخل التصميم). «الموافقة على السحوبات» في التصميم تُترجم إلى المراجعة والموافقة فقط، دون الرفض والصرف. لا يتضمن إدارة الأدوار أو الموظفين.' },
	{ key: 'disputes_supervisor', name: 'مشرف نزاعات', description: 'يحل النزاعات ويراجع البلاغات', color: '#A56BE0',
		permissions: ['users.view', 'users.suspend', 'disputes.view', 'disputes.resolve', 'reports.view', 'messages.use'],
		notes: 'بطاقة الدور في التصميم تذكر 8 صلاحيات والمصفوفة 5 فقط.' },
	{ key: 'support_supervisor', name: 'مشرف دعم', description: 'يعالج تذاكر الدعم الفني', color: '#2BD4C7',
		permissions: ['users.view', 'reports.view', 'support.review', 'support.reply', 'messages.use'],
		notes: 'بطاقة الدور في التصميم تذكر 6 صلاحيات والمصفوفة 3 فقط. قرار وظيفي من صاحب القرار (2026-10-25): «مراجعة الدعم» تعني معالجة التذاكر، فيُمنح الرد وتغيير الحالة والأولوية والملاحظات الداخلية وتكليف التذكرة **لنفسه**. لا يُمنح توزيع المهام على الآخرين (tasks.manage) ولا إدارة الموظفين ولا الصرف ولا حل النزاعات.' },
	{ key: 'content_supervisor', name: 'مشرف محتوى', description: 'يعتمد التخصصات والملفات', color: '#5DA0FF',
		permissions: ['specialties.approve', 'messages.use'],
		notes: 'بطاقة الدور في التصميم تذكر 5 صلاحيات والمصفوفة صفًا واحدًا.' },
	{ key: 'finance_supervisor', name: 'مشرف مالي', description: 'يراجع السحوبات والمعاملات', color: '#0FA99A',
		permissions: ['withdrawals.review', 'withdrawals.approve', 'finance.read', 'messages.use'],
		notes: 'بطاقة الدور في التصميم تذكر 4 صلاحيات والمصفوفة صفين. الرفض والصرف منفصلان ولا يُمنحان من القالب.' },
] as const;

/** Open points between the design pages and the approved list: shown to the SUPER_ADMIN, never silently decided. */
export const AMBIGUITIES: readonly string[] = [
	'بطاقات الأدوار في P-AD-024 تذكر أعداد صلاحيات (15/11/8/6/5/4) لا تطابق عدد الصفوف المعلَّمة في المصفوفة نفسها.',
	'صفحة الموظف P-AD-022-موظف تعرض 10 صلاحيات بأسماء لا ترد في مصفوفة P-AD-024 («حذف المحتوى المسيء»، «حل البلاغات»، «عرض سجلات المستخدمين»، «الوصول للمالية»، «حذف الحسابات نهائيًا»…). لم تُضف كصلاحيات.',
	'نافذة الدعوة تعرض «الأقسام المتاحة» (المستخدمون، النزاعات، البلاغات، الدعم الفني، التخصصات) دون تعريف لعلاقتها بالصلاحيات. لم تُنفَّذ كي لا توحي بسلطة غير مطبّقة.',
	'«الموافقة على السحوبات» صف واحد في التصميم، بينما القرار المعتمد يفصل المراجعة والموافقة والرفض والصرف.',
	'«حل البلاغات» (صفحة الموظف) غير موجود في القائمة المعتمدة: المتاح عرض البلاغات ومراجعة الدعم فقط.',
];

export const ADMIN_PERMISSION_COUNT = ADMIN_PERMISSIONS.length;

/**
 * «الأقسام المتاحة» (design P-AD-022 invitation dialog): the five sections a member can be scoped to. A section is a DATA scope: when a staff member is scoped, a permission that belongs to a
 * section only applies if that section is listed. It narrows and never grants; permissions without a section (finance, settings, team, identity review ...) are not affected by it.
 */
export const ADMIN_DEPARTMENTS = [
	{ key: 'users', label: 'المستخدمون' },
	{ key: 'disputes', label: 'النزاعات' },
	{ key: 'reports', label: 'البلاغات' },
	{ key: 'support', label: 'الدعم الفني' },
	{ key: 'specialties', label: 'التخصصات' },
] as const;
export type AdminDepartmentKey = typeof ADMIN_DEPARTMENTS[number]['key'];
export const ADMIN_DEPARTMENT_KEYS: readonly string[] = ADMIN_DEPARTMENTS.map(d => d.key);
export const isKnownDepartment = (k: string): boolean => ADMIN_DEPARTMENT_KEYS.includes(k);
export const PERMISSION_DEPARTMENT: Readonly<Record<string, AdminDepartmentKey>> = {
	'users.view': 'users', 'users.suspend': 'users', 'users.delete': 'users',
	'disputes.view': 'disputes', 'disputes.note': 'disputes', 'disputes.assign': 'disputes', 'disputes.resolve': 'disputes',
	'reports.view': 'reports',
	'support.review': 'support', 'support.reply': 'support',
	'specialties.approve': 'specialties', 'content.manage': 'specialties', 'business_models.review': 'specialties',
};
/** the permissions of a scoped member: the ones outside the listed sections are removed (never added) */
export const applyDepartmentScope = (ids: Iterable<string>, scoped: boolean, departments: readonly string[]): Set<string> => {
	const out = new Set<string>();
	for (const id of ids) { const d = PERMISSION_DEPARTMENT[id]; if (!scoped || !d || departments.includes(d)) out.add(id); }
	return out;
};
