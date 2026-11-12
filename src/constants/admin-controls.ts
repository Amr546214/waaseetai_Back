/**
 * Stable reason codes of the admin controls over requests / offers / contracts / escrow. The FE maps every code to its own Arabic copy (it never shows a generic «غير متاح»);
 * the message here is the server's own Arabic sentence for logs / API consumers. A code is NEVER renamed: the FE and the tests branch on it.
 */
export const ADMIN_CONTROL_REASONS = {
	// shared
	SUPER_ADMIN_REQUIRED: 'القرار المالي لمدير النظام (Super Admin) وحده.',
	PERMISSION_DENIED: 'ليست لديك صلاحية تنفيذ هذا الإجراء.',
	NOT_FOUND: 'العنصر المطلوب غير موجود.',
	IDEMPOTENCY_KEY_REQUIRED: 'مفتاح منع التكرار (Idempotency-Key) مطلوب لهذا الإجراء.',
	IDEMPOTENCY_KEY_CONFLICT: 'استُخدم مفتاح منع التكرار نفسه لطلب مختلف. أعد المحاولة بمفتاح جديد.',
	REASON_REQUIRED: 'اكتب سبب القرار (5 أحرف على الأقل).',
	REASON_TOO_LONG: 'سبب القرار طويل (الحد الأقصى 500 حرف).',
	CONFIRMATION_REQUIRED: 'يلزم تأكيد صريح لتنفيذ هذا الإجراء.',
	VERSION_REQUIRED: 'حدّث الصفحة: نسخة العنصر المعروضة مطلوبة.',
	STALE_VERSION: 'تغيّر العنصر منذ عرضه عليك. حدّث الصفحة وراجع الحالة ثم أعد التأكيد.',
	// request
	REQUEST_DRAFT: 'الطلب مسودة ولم يُنشر بعد.',
	REQUEST_NOT_OPEN: 'يمكن تعليق الطلب المفتوح لاستقبال العروض فقط.',
	REQUEST_HAS_CONTRACT: 'للطلب عقد مرتبط: يُدار من العقد ولا يُعلَّق.',
	REQUEST_ALREADY_SUSPENDED: 'الطلب معلّق بالفعل.',
	REQUEST_NOT_SUSPENDED: 'الطلب غير معلّق.',
	REQUEST_ALREADY_CANCELLED: 'الطلب ملغى بالفعل.',
	REQUEST_COMPLETED: 'الطلب مكتمل ولا يُلغى.',
	REQUEST_SETTLED: 'الطلب أُغلق بتسوية مالية ولا يُلغى.',
	// offer
	OFFER_ALREADY_SUSPENDED: 'العرض معلّق بالفعل.',
	OFFER_NOT_SUSPENDED: 'العرض غير معلّق.',
	OFFER_STATE_NOT_SUSPENDABLE: 'لا يُعلَّق العرض في حالته الحالية (يُعلَّق العرض الحي فقط).',
	OFFER_LINKED_TO_CONTRACT: 'العرض مرتبط بعقد: يُدار من العقد ولا تُغيَّر حالته وحدها.',
	OFFER_REQUEST_CLOSED: 'الطلب المرتبط بالعرض مغلق (ملغى أو مكتمل).',
	// contract / escrow
	NO_CONTRACT: 'لا يوجد عقد لهذا الطلب.',
	CONTRACT_CLOSED: 'العقد مغلق (مكتمل أو ملغى).',
	CONTRACT_ALREADY_FROZEN: 'العقد مجمّد بالفعل.',
	CONTRACT_NOT_FROZEN: 'العقد غير مجمّد.',
	CONTRACT_FROZEN: 'العقد مجمّد: فُكّ التجميد أولًا قبل أي حركة مالية.',
	ACTIVE_DISPUTE: 'يوجد نزاع مفتوح على المشروع: يُحسم النزاع أولًا ولا تُنفَّذ حركة مالية إدارية بجانبه.',
	CANCELLATION_AGREED_PENDING_SETTLEMENT: 'اتفق الطرفان على الإلغاء بالتراضي والتسوية بانتظار الإدارة: تُنفَّذ من شاشة طلبات الإلغاء.',
	NO_ESCROW: 'لا يوجد ضمان لهذا العقد.',
	ESCROW_ALREADY_RELEASED: 'الضمان صُرف بالكامل لمقدم الخدمة ولا يوجد مبلغ محتجز.',
	ESCROW_ALREADY_REFUNDED: 'الضمان أُعيد إلى العميل مسبقًا ولا يوجد مبلغ محتجز.',
	NO_HELD_BALANCE: 'لا يوجد مبلغ محتجز في الضمان.',
	EXPECTED_AMOUNT_REQUIRED: 'المبلغ المحتجز الذي عُرض عليك (expectedHeldAmount) مطلوب.',
	HELD_BALANCE_CHANGED: 'تغيّر المبلغ المحتجز منذ عرضه عليك. حدّث الصفحة وراجع المبالغ ثم أعد التأكيد.',
	RELEASE_REQUIRES_ACTIVE_CONTRACT: 'لا يُصرف الضمان لمقدم الخدمة إلا لعقد نشط وقّعه الطرفان.',
	CANCELLATION_SETTLEMENT_NOT_APPROVED: 'الإلغاء المباشر لا يحسم مصير مبلغ محتجز لأن قاعدة التسوية لم تُعتمد من المنتج بعد. استخدم إجراء «إعادة المبلغ للطالب» أو «الإفراج لمقدم الخدمة» (لكل منهما معاينة أثره) وهو يُغلق العقد.',
	SETTLEMENT_CHOICE_REQUIRED: 'العقد يحتجز مبلغًا: اختر التسوية صراحةً (إعادة المحتجز للعميل).',
	PARTIAL_SETTLEMENT_NOT_DEFINED: 'لم يُعتمد قرار منتج لتقسيم المبلغ المحتجز بين الطرفين عند إلغاء إداري منفرد.',
	ESCROW_CHANGED: 'تغيّر الضمان أثناء التنفيذ ولم يُنفَّذ أي مبلغ. أعد المحاولة.'
} as const;
export type AdminControlReason = keyof typeof ADMIN_CONTROL_REASONS;
export const adminControlMessage = (code: AdminControlReason): string => ADMIN_CONTROL_REASONS[code];

export type AdminControlAction =
	| 'REQUEST_SUSPEND' | 'REQUEST_RESUME' | 'REQUEST_CANCEL'
	| 'OFFER_SUSPEND' | 'OFFER_RESUME'
	| 'CONTRACT_FREEZE' | 'CONTRACT_UNFREEZE' | 'CONTRACT_CANCEL' | 'ESCROW_REFUND' | 'ESCROW_RELEASE';

/** the only settlement a unilateral admin cancellation supports: the whole held balance goes back to the client (no split is defined, see PARTIAL_SETTLEMENT_NOT_DEFINED) */
export const SETTLEMENT_REFUND_ALL = 'REFUND_ALL_TO_CLIENT';
