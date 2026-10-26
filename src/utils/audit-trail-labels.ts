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
	USER: 'حساب', ROLE: 'دور', INVITE: 'دعوة', SETTINGS: 'إعدادات', FEE_POLICY: 'سياسة الرسوم'
};

/** the Arabic name of an event code; an unknown code is returned unchanged (honest, never replaced by a generic label) */
export const auditActionLabel = (code: string): string => AUDIT_ACTION_LABELS[code] ?? code;

/** actions of the admin access trail (they carry no severity of their own; this table is the only place it is decided) */
export const ACCESS_ACTION_SEVERITY: Record<string, 'INFO' | 'WARNING' | 'CRITICAL'> = { STAFF_SUSPENDED: 'WARNING' };
export const accessActionSeverity = (action: string): 'INFO' | 'WARNING' | 'CRITICAL' => ACCESS_ACTION_SEVERITY[action] ?? 'INFO';
