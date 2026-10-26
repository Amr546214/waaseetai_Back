/**
 * Arabic names of the audit event codes the platform really writes (AccountAuditLog.eventType and AdminAccessAudit.action). The code is the identity:
 * an unknown code is shown as the code itself, never guessed or replaced by a generic phrase.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
	// sessions / own account
	SESSION_STARTED: 'تسجيل دخول جديد',
	SESSION_LOGOUT: 'تسجيل خروج',
	SESSION_REVOKED: 'إنهاء جلسة دخول',
	SESSIONS_REVOKED_OTHERS: 'إنهاء باقي الجلسات',
	SESSIONS_REVOKED_ALL: 'إنهاء كل الجلسات',
	LOGIN_REJECTED: 'محاولة تسجيل دخول مرفوضة',
	PASSWORD_CHANGED: 'تغيير كلمة المرور',
	PASSWORD_CHANGE_REQUESTED: 'طلب تغيير كلمة المرور',
	PASSWORD_CHANGE_REJECTED: 'محاولة تغيير كلمة المرور مرفوضة',
	OTP_VERIFIED: 'تأكيد رمز التحقق',
	OTP_VERIFICATION_REJECTED: 'رفض رمز التحقق',
	SENSITIVE_CHANGE_REQUESTED: 'طلب تعديل حساس',
	PROFILE_UPDATED: 'تعديل بيانات الحساب',
	ROLE_SWITCHED: 'تبديل الحساب النشط',
	ROLE_ADDED: 'إضافة دور للحساب',
	PAYPAL_EMAIL_CHANGED: 'تغيير بريد PayPal',
	// platform
	PLATFORM_SETTINGS_UPDATED: 'تعديل إعدادات المنصة',
	FEE_POLICY_SCHEDULED: 'جدولة تعديل سياسة الرسوم',
	FEE_POLICY_CANCELLED: 'إلغاء نسخة مجدولة من سياسة الرسوم',
	// back-office actions
	ADMIN_MESSAGE_SENT: 'رسالة من الإدارة',
	USER_DELETED_BY_ADMIN: 'حذف حساب مستخدم نهائيًا',
	ROLES_CHANGED_BY_ADMIN: 'تعديل أدوار حساب من الإدارة',
	KYC_APPROVED_BY_ADMIN: 'اعتماد توثيق الهوية',
	KYC_REJECTED_BY_ADMIN: 'رفض توثيق الهوية',
	KYC_DOCUMENT_VIEWED_BY_ADMIN: 'اطلاع على مستند هوية',
	MARKETER_KYC_APPROVED: 'اعتماد هوية الوسيط',
	MARKETER_KYC_REJECTED: 'رفض مستند هوية الوسيط',
	MARKETER_KYC_DOCUMENT_SUBMITTED: 'رفع مستند هوية الوسيط',
	ACCREDITATION_APPROVED_BY_ADMIN: 'اعتماد نموذج الاعتماد',
	ACCREDITATION_REJECTED_BY_ADMIN: 'رفض نموذج الاعتماد',
	ACCREDITATION_COMPLETION_REQUESTED: 'طلب استكمال بيانات الاعتماد',
	SPECIALTY_ADMIN_DECISION: 'قرار إداري على تخصص',
	SPECIALTY_CREATED: 'إضافة تخصص',
	SPECIALTY_UPDATED: 'تعديل تخصص',
	SPECIALTY_DELETED: 'حذف تخصص',
	CATEGORY_CREATED: 'إضافة قسم',
	CATEGORY_UPDATED: 'تعديل قسم',
	CATEGORY_DELETED: 'حذف قسم',
	MARKETING_ASSET_CREATED: 'إضافة مادة تسويقية',
	DISPUTE_ASSIGNED: 'إسناد نزاع',
	DISPUTE_NOTE: 'ملاحظة داخلية على نزاع',
	DISPUTE_STATUS_CHANGED: 'تغيير حالة نزاع',
	DISPUTE_FINANCIAL_RESOLVED: 'تسوية مالية لنزاع',
	TICKET_ASSIGNED: 'تكليف تذكرة',
	TICKET_INTERNAL_NOTE: 'ملاحظة داخلية على تذكرة',
	TICKET_PRIORITY_CHANGED: 'تغيير أولوية تذكرة',
	TICKET_REPLIED: 'ردّ على تذكرة',
	TICKET_STATUS_CHANGED: 'تغيير حالة تذكرة',
	WITHDRAWAL_APPROVED: 'اعتماد طلب سحب',
	WITHDRAWAL_REJECTED: 'رفض طلب سحب',
	WITHDRAWAL_PAYOUT_SENT: 'إرسال تحويل سحب',
	FINANCE_EXPORT: 'تصدير بيانات مالية',
	ACCOUNT_SUSPENDED_BY_ADMIN: 'إيقاف حساب من الإدارة',
	ACCOUNT_ACTIVATED_BY_ADMIN: 'إعادة تفعيل حساب من الإدارة',
	BROKER_SUSPENDED: 'إيقاف حساب وسيط',
	BROKER_REACTIVATED: 'إعادة تفعيل حساب وسيط',
	COUPON_ADMIN_DEACTIVATED: 'إيقاف كوبون من الإدارة',
	COUPON_ADMIN_REACTIVATED: 'إعادة تفعيل كوبون من الإدارة',
	CATEGORY_ENABLED: 'تفعيل قسم', CATEGORY_DISABLED: 'تعطيل قسم', SPECIALTY_ENABLED: 'تفعيل تخصص', SPECIALTY_DISABLED: 'تعطيل تخصص',
	MARKETING_ASSET_UPDATED: 'تعديل مادة تسويقية', MARKETING_ASSET_ENABLED: 'تفعيل مادة تسويقية', MARKETING_ASSET_DISABLED: 'تعطيل مادة تسويقية',
	MARKETPLACE_SERVICE_APPROVE: 'اعتماد خدمة في السوق', MARKETPLACE_SERVICE_REJECT: 'رفض خدمة في السوق', MARKETPLACE_SERVICE_HIDE: 'إخفاء خدمة في السوق',
	DISPUTE_RESOLVED: 'حسم نزاع', DISPUTE_REJECTED: 'رفض نزاع',
	HUMAN_REVIEW_COMPLETED: 'اكتمال مراجعة بشرية',
	WALLET_DEPOSIT_COMPLETED: 'اكتمال شحن المحفظة',
	STAGE_FUND_RELEASED: 'إفراج عن مبلغ مرحلة', AMENDMENT_APPLIED: 'تطبيق تعديل على عقد',
	PROJECT_EMPLOYEE_ASSIGNED: 'تعيين موظف مسؤول عن مشروع', PROJECT_EMPLOYEE_UNASSIGNED: 'إلغاء تعيين موظف مسؤول عن مشروع', PROJECT_EMPLOYEE_REASSIGNED: 'تغيير الموظف المسؤول عن مشروع',
	// admin access trail (AdminAccessAudit.action)
	ROLE_CREATED: 'إنشاء دور إداري',
	ROLE_UPDATED: 'تعديل دور إداري',
	INVITE_CREATED: 'إنشاء دعوة موظف',
	INVITE_RESENT: 'إعادة إرسال دعوة',
	INVITE_CANCELLED: 'إلغاء دعوة',
	INVITE_ACCEPTED: 'قبول دعوة',
	STAFF_ATTACHED: 'ضم حساب إلى الفريق',
	STAFF_ROLE_SET: 'تغيير دور موظف',
	STAFF_SUSPENDED: 'إيقاف موظف',
	STAFF_REACTIVATED: 'إعادة تفعيل موظف',
	STAFF_ACCESS_SET: 'تخصيص صلاحيات موظف',
	STAFF_ACCESS_RESET: 'إعادة صلاحيات موظف إلى دوره'
};

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
	DISPUTE: 'نزاع', TICKET: 'تذكرة', WITHDRAWAL: 'طلب سحب', ESCROW: 'ضمان', PROJECT: 'مشروع', CONTRACT: 'عقد', FINANCE: 'مالية',
	USER: 'حساب', ROLE: 'دور', INVITE: 'دعوة', SETTINGS: 'إعدادات', FEE_POLICY: 'سياسة الرسوم', COUPON: 'كوبون'
};

/** the Arabic name of an event code; an unknown code is returned unchanged (honest, never replaced by a generic label) */
export const auditActionLabel = (code: string): string => AUDIT_ACTION_LABELS[code] ?? code;

/** actions written to admin_access_audit: that table is the system of record for them; an account_audit_logs row carrying one of these codes is a mirror and is not listed twice */
export const ACCESS_ACTION_CODES = ['ROLE_CREATED', 'ROLE_UPDATED', 'INVITE_CREATED', 'INVITE_RESENT', 'INVITE_CANCELLED', 'INVITE_ACCEPTED', 'STAFF_ATTACHED', 'STAFF_ROLE_SET', 'STAFF_SUSPENDED', 'STAFF_REACTIVATED', 'STAFF_ACCESS_SET', 'STAFF_ACCESS_RESET'];

/** events a person does on their OWN account (the owner of the row is the actor) when the row's source is USER */
export const SELF_ACTED_CODES = ['SESSION_STARTED', 'SESSION_LOGOUT', 'SESSION_REVOKED', 'SESSIONS_REVOKED_OTHERS', 'SESSIONS_REVOKED_ALL', 'PASSWORD_CHANGED', 'PASSWORD_CHANGE_REQUESTED', 'PASSWORD_CHANGE_REJECTED', 'OTP_VERIFIED', 'OTP_VERIFICATION_REJECTED', 'SENSITIVE_CHANGE_REQUESTED', 'PROFILE_UPDATED', 'ROLE_SWITCHED', 'ROLE_ADDED', 'PAYPAL_EMAIL_CHANGED', 'WALLET_DEPOSIT_COMPLETED', 'MARKETER_KYC_DOCUMENT_SUBMITTED', 'PROJECT_EMPLOYEE_ASSIGNED', 'PROJECT_EMPLOYEE_UNASSIGNED', 'PROJECT_EMPLOYEE_REASSIGNED'];
