/**
 * ONE central, documented classification of every audit event code the platform writes (account_audit_logs.eventType and admin_access_audit.action)
 * into INFO / WARNING / CRITICAL by the NATURE of the action. Nothing is inferred from data that is not stored. A code that is not listed here is
 * shown «غير مصنّف» (UNCLASSIFIED, a neutral badge) - never a guessed severity. utils/audit-trail-classification.test.ts fails when a code written
 * anywhere in src has no class here. The same table is reproduced in AUDIT-TRAIL-CLASSIFICATION-2026-10-26.md (generated from this file).
 *
 * Stored severity: account_audit_logs.severity is always written (default INFO), so a stored INFO cannot be told from the default and never lowers a
 * classification; a stored WARNING / CRITICAL is always honoured. effective = the higher of (stored, classification); a code with no class and a
 * stored INFO/empty is UNCLASSIFIED.
 */
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
export type EffectiveSeverity = Severity | 'UNCLASSIFIED';

export interface AuditClass { id: string; severity: Severity; reason: string; codes: string[] }

export const AUDIT_CLASSES: AuditClass[] = [
	{ id: 'irreversible', severity: 'CRITICAL', reason: 'تدمير غير قابل للتراجع أو خروج أموال فعلي بقرار إداري', codes: ['USER_DELETED_BY_ADMIN', 'WITHDRAWAL_PAYOUT_SENT', 'DISPUTE_FINANCIAL_RESOLVED'] },
	{ id: 'access-authority', severity: 'WARNING', reason: 'تغيير في من يملك الصلاحية أو حالة حساب (إيقاف / تفعيل / دور / دعوة مقبولة)', codes: ['ROLE_CREATED', 'ROLE_UPDATED', 'ROLES_CHANGED_BY_ADMIN', 'INVITE_CREATED', 'INVITE_ACCEPTED', 'STAFF_ATTACHED', 'STAFF_ROLE_SET', 'STAFF_ACCESS_SET', 'STAFF_ACCESS_RESET', 'STAFF_SUSPENDED', 'STAFF_REACTIVATED', 'ACCOUNT_SUSPENDED_BY_ADMIN', 'ACCOUNT_ACTIVATED_BY_ADMIN', 'BROKER_SUSPENDED', 'BROKER_REACTIVATED'] },
	{ id: 'platform-policy', severity: 'WARNING', reason: 'تعديل إعدادات المنصة أو سياسة الرسوم، ويؤثر على كل المستخدمين', codes: ['PLATFORM_SETTINGS_UPDATED', 'FEE_POLICY_SCHEDULED', 'FEE_POLICY_CANCELLED'] },
	{ id: 'failed-auth', severity: 'WARNING', reason: 'محاولة دخول أو تحقق أو تغيير كلمة مرور مرفوضة', codes: ['LOGIN_REJECTED', 'PASSWORD_CHANGE_REJECTED', 'OTP_VERIFICATION_REJECTED'] },
	{ id: 'credential-change', severity: 'WARNING', reason: 'تغيير وسيلة دخول أو استلام أموال، أو إنهاء كل الجلسات', codes: ['PASSWORD_CHANGED', 'PAYPAL_EMAIL_CHANGED', 'SESSIONS_REVOKED_ALL'] },
	{ id: 'financial-decision', severity: 'WARNING', reason: 'قرار أو حركة مالية أو تصدير بيانات مالية', codes: ['WITHDRAWAL_APPROVED', 'WITHDRAWAL_REJECTED', 'STAGE_FUND_RELEASED', 'FINANCE_EXPORT', 'AMENDMENT_APPLIED'] },
	{ id: 'sensitive-access-delete', severity: 'WARNING', reason: 'اطلاع على وثيقة هوية أو حذف عنصر من الدليل', codes: ['KYC_DOCUMENT_VIEWED_BY_ADMIN', 'CATEGORY_DELETED', 'SPECIALTY_DELETED', 'MARKETPLACE_SERVICE_REJECT', 'MARKETPLACE_SERVICE_HIDE'] },
	{ id: 'routine', severity: 'INFO', reason: 'نشاط اعتيادي أو قابل للتراجع أو قراءة فقط', codes: [
		'SESSION_STARTED', 'SESSION_LOGOUT', 'SESSION_REVOKED', 'SESSIONS_REVOKED_OTHERS', 'OTP_VERIFIED', 'PASSWORD_CHANGE_REQUESTED', 'SENSITIVE_CHANGE_REQUESTED', 'PROFILE_UPDATED', 'ROLE_SWITCHED', 'ROLE_ADDED', 'WALLET_DEPOSIT_COMPLETED',
		'INVITE_RESENT', 'INVITE_CANCELLED', 'ADMIN_MESSAGE_SENT',
		'KYC_APPROVED_BY_ADMIN', 'KYC_REJECTED_BY_ADMIN', 'MARKETER_KYC_APPROVED', 'MARKETER_KYC_REJECTED', 'MARKETER_KYC_DOCUMENT_SUBMITTED', 'ACCREDITATION_APPROVED_BY_ADMIN', 'ACCREDITATION_REJECTED_BY_ADMIN', 'ACCREDITATION_COMPLETION_REQUESTED', 'SPECIALTY_ADMIN_DECISION', 'HUMAN_REVIEW_COMPLETED',
		'CATEGORY_CREATED', 'CATEGORY_UPDATED', 'CATEGORY_ENABLED', 'CATEGORY_DISABLED', 'SPECIALTY_CREATED', 'SPECIALTY_UPDATED', 'SPECIALTY_ENABLED', 'SPECIALTY_DISABLED',
		'MARKETING_ASSET_CREATED', 'MARKETING_ASSET_UPDATED', 'MARKETING_ASSET_ENABLED', 'MARKETING_ASSET_DISABLED', 'MARKETPLACE_SERVICE_APPROVE', 'COUPON_ADMIN_DEACTIVATED', 'COUPON_ADMIN_REACTIVATED',
		'DISPUTE_ASSIGNED', 'DISPUTE_NOTE', 'DISPUTE_STATUS_CHANGED', 'DISPUTE_RESOLVED', 'DISPUTE_REJECTED', 'TICKET_ASSIGNED', 'TICKET_INTERNAL_NOTE', 'TICKET_PRIORITY_CHANGED', 'TICKET_REPLIED', 'TICKET_STATUS_CHANGED',
		'PROJECT_EMPLOYEE_ASSIGNED', 'PROJECT_EMPLOYEE_UNASSIGNED', 'PROJECT_EMPLOYEE_REASSIGNED'
	] }
];

/** generic fallbacks written when a caller gave no specific code (account-logs legacyEventType); they carry no fact about the action, so they stay «غير مصنّف» on purpose */
export const GENERIC_FALLBACK_CODES = ['SECURITY_CHANGED', 'SYSTEM_EVENT', 'ADMIN_EVENT'];

export const SEVERITY_BY_CODE: ReadonlyMap<string, Severity> = new Map(AUDIT_CLASSES.flatMap(c => c.codes.map(code => [code, c.severity] as const)));
export const codesOf = (s: Severity): string[] => AUDIT_CLASSES.filter(c => c.severity === s).flatMap(c => c.codes);
export const ALL_CLASSIFIED_CODES: string[] = [...SEVERITY_BY_CODE.keys()];
const RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

export function classifiedSeverity(code: string): Severity | null { return SEVERITY_BY_CODE.get(code) ?? null; }

/** the severity shown for an event: the higher of the stored one (WARNING / CRITICAL only; INFO is the column default) and the class; neither -> UNCLASSIFIED */
export function effectiveSeverity(code: string, stored?: string | null): { severity: EffectiveSeverity; source: 'stored' | 'classification' | 'none' } {
	const st: Severity | null = stored === 'WARNING' || stored === 'CRITICAL' ? stored : null;
	const cl = classifiedSeverity(code);
	if (st && (!cl || RANK[st] >= RANK[cl])) return { severity: st, source: 'stored' };
	if (cl) return { severity: cl, source: 'classification' };
	return { severity: 'UNCLASSIFIED', source: 'none' };
}
