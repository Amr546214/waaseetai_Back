import { z } from 'zod';

/**
 * THE registry of platform settings (P-AD-020 «إعدادات النظام» + P-AD-021 «Super Admin»). One key = one place: both pages read and write the same key, no page keeps its own copy.
 * Rule: a setting is editable ONLY when something real enforces it (`status: 'enforced'`). What cannot be enforced yet is listed with the reason (`blocked`) or shown as the
 * read-only value the system really uses today (`readonly`); it is never stored as a switch that changes nothing.
 *
 * `read` / `write`: 'settings.view' | 'settings.manage' (registry permissions) | 'SUPER' (SUPER_ADMIN only; the account type read from the database). A SUPER_ADMIN passes every check.
 * Secrets never live here: integrations keys stay in the server environment and only "configured yes/no" is reported.
 */
export type SettingStatus = 'enforced' | 'readonly' | 'blocked';
export type SettingPerm = 'settings.view' | 'settings.manage' | 'SUPER';
export type SettingEffect = 'immediate' | 'within-5s' | 'new-sessions';
export type SettingTab = 'general' | 'content' | 'ai' | 'notifications' | 'security' | 'finance' | 'regional' | 'integrations' | 'danger';

export interface SettingDef {
	key: string;
	tab: SettingTab;
	label: string;
	description: string;
	status: SettingStatus;
	/** why it cannot be changed from here (blocked / readonly) */
	reason?: string;
	/** enforced only */
	schema?: z.ZodType<unknown>;
	default?: unknown;
	allowed?: readonly unknown[];
	unit?: string;
	public?: boolean;
	read: SettingPerm;
	write: SettingPerm;
	effect?: SettingEffect;
	/** where it is enforced / read (documentation + matrix) */
	consumers: string[];
	/** the test that proves the effect */
	proof?: string;
	/** which design pages show it */
	pages: Array<'P-AD-020' | 'P-AD-021'>;
	/** the value the system really uses today (readonly) */
	current?: () => { value: unknown; source: string };
}

const text = (max: number) => z.string().trim().max(max);
const bool = z.boolean();
const emailOrEmpty = z.union([z.literal(''), z.string().trim().email('البريد غير صالح').max(120)]);
const phoneOrEmpty = text(30).regex(/^[0-9+()\-\s]*$/, 'رقم الهاتف غير صالح');
export const SESSION_IDLE_ALLOWED = { min: 5, max: 10080 } as const;

const AI_SCOPE = 'تغييرات الذكاء الاصطناعي والمزوّد والمفاتيح و Cloud Run نطاق منفصل: يُجرد هنا فقط ولا يُعدَّل تشغيله من هذه الصفحة.';
const FEE_POLICY = 'تُحدَّد بسياسة الرسوم v2 المثبتة في الكود (قرار مالي موثّق) وتُعرض في «الباقات والرسوم»؛ جعلها قابلة للتعديل من هنا يحتاج قرارًا بمصدر الحقيقة (الإعداد أم السياسة).';

export const SETTING_DEFS: readonly SettingDef[] = [
	// ───────────── general ─────────────
	{ key: 'platformName', tab: 'general', label: 'اسم النظام', description: 'يظهر في المراسلات الرسمية والفواتير وكاسم المرسل في البريد.', status: 'enforced', schema: text(80).min(1, 'اسم المنصة مطلوب'), default: '', public: true,
		read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings', 'اسم المرسل في البريد الصادر (utils/mail.transporter)', 'بنر الصيانة'], proof: 'system-settings.pg.test: platformName reaches the mail sender and public settings', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'maintenanceMode', tab: 'general', label: 'وضع الصيانة', description: 'يوقف الوصول لجميع المستخدمين مؤقتًا. يبقى متاحًا: الصحة، الدخول، الإعدادات العامة، لوحة الإدارة (بصلاحياتها)، واستدعاءات الدفع الواردة.', status: 'enforced', schema: bool, default: false,
		read: 'SUPER', write: 'SUPER', effect: 'within-5s', consumers: ['middlewares/maintenance.middleware (كل طلب HTTP)'], proof: 'maintenance.middleware.test + system-settings.pg.test: maintenance is enforced on traffic', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'maintenanceBannerEnabled', tab: 'general', label: 'بنر الصيانة/الإعلان', description: 'يعرض البنر أعلى التطبيق دون إيقاف الخدمة.', status: 'enforced', schema: bool, default: false, public: true,
		read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings', 'PlatformBanner (الواجهة)'], proof: 'FE platform-banner.spec + sa-system-settings.spec', pages: ['P-AD-020'] },
	{ key: 'maintenanceBannerText', tab: 'general', label: 'نص البنر', description: 'النص الظاهر في البنر ورسالة الصيانة.', status: 'enforced', schema: text(300), default: '', public: true,
		read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings', 'PlatformBanner', 'رد 503 أثناء الصيانة'], proof: 'FE platform-banner.spec + sa-system-settings.spec', pages: ['P-AD-020'] },
	{ key: 'registrationOpen', tab: 'general', label: 'تسجيل حسابات جديدة', description: 'السماح بإنشاء حسابات جديدة. عند الإغلاق يرفض الخادم التسجيل نفسه (وليس إخفاء الزر فقط).', status: 'enforced', schema: bool, default: true, public: true,
		read: 'settings.view', write: 'SUPER', effect: 'within-5s', consumers: ['auth.service registerUser / googleAuth(register)', 'GET /public/settings (يخفي الواجهة)'], proof: 'system-settings.pg.test: registration closed => 403 REGISTRATION_CLOSED', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'supportEmail', tab: 'general', label: 'بريد الدعم', description: 'العنوان العام للتواصل مع الدعم.', status: 'enforced', schema: emailOrEmpty, default: '', public: true, read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings'], proof: 'admin-content.flow.test + system-settings.pg.test (public values, versioned save, audit)', pages: ['P-AD-020'] },
	{ key: 'supportPhone', tab: 'general', label: 'هاتف الدعم', description: 'رقم التواصل العام.', status: 'enforced', schema: phoneOrEmpty, default: '', public: true, read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings'], proof: 'admin-content.flow.test + system-settings.pg.test (public values, versioned save, audit)', pages: ['P-AD-020'] },
	{ key: 'defaultLanguage', tab: 'general', label: 'اللغة الافتراضية', description: 'لغة الواجهة الرئيسية.', status: 'readonly', reason: 'الواجهة عربية فقط حاليًا؛ لا توجد ترجمة إنجليزية فلا يُعرض خيار لا يعمل.', read: 'settings.view', write: 'SUPER', consumers: ['الواجهة'], pages: ['P-AD-021'], current: () => ({ value: 'ar', source: 'ثابت في الواجهة (عربي RTL فقط)' }) },
	{ key: 'emailRegistration', tab: 'general', label: 'التسجيل بالبريد الإلكتروني', description: 'إنشاء حساب بالبريد.', status: 'readonly', reason: 'التسجيل بالبريد هو المسار الوحيد المتاح (مع جوجل كتحقق من الهوية)؛ تعطيله يغلق التسجيل كليًا، فاستعمل «تسجيل حسابات جديدة».', read: 'settings.view', write: 'SUPER', consumers: ['auth.service'], pages: ['P-AD-021'], current: () => ({ value: true, source: 'مسار التسجيل الوحيد' }) },
	{ key: 'phoneOtpAtRegistration', tab: 'general', label: 'التحقق بالجوال إلزامي', description: 'OTP عند التسجيل.', status: 'blocked', reason: 'التحقق عند الدخول يتم برمز البريد (قرار المالك)، ومزوّد SMS غير منفّذ (SMS_PROVIDER_IMPLEMENTED=false).', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'kycBeforeOffers', tab: 'general', label: 'التحقق من الهوية قبل قبول العروض', description: 'KYC إلزامي قبل قبول العروض.', status: 'blocked', reason: 'شروط التوثيق مفروضة بالكود في مسارات محددة (اعتماد المزوّد/التخصص)، وليست مرتبطة بإعداد قابل للتبديل؛ ربطها يحتاج قرارًا بالإجراءات المشمولة.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'projectReviewBeforePublish', tab: 'content', label: 'مراجعة المشاريع قبل النشر', description: 'يراجعها مشرف قبل الظهور.', status: 'blocked', reason: 'دورة المراجعة مفروضة بالكود (حالات PENDING_REVIEW)؛ لا يوجد مسار «نشر مباشر» لتفعيله.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'providerProfileApproval', tab: 'content', label: 'مراجعة الملفات الشخصية', description: 'اعتماد مقدمي الخدمة يدويًا.', status: 'blocked', reason: 'اعتماد المزوّد يدوي دائمًا في الكود؛ لا يوجد مسار اعتماد تلقائي.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'profanityFilter', tab: 'content', label: 'فلتر الكلمات المسيئة', description: 'AI يفلتر الرسائل والمحتوى.', status: 'blocked', reason: 'لا يوجد فلتر كلمات منفّذ؛ والذكاء الاصطناعي نطاق منفصل.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'liveSupportAssistant', tab: 'general', label: 'الدعم الفوري', description: 'تفعيل المساعد AI للدعم الفوري.', status: 'blocked', reason: AI_SCOPE, read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-020'] },
	// ───────────── content (legal) ─────────────
	{ key: 'termsVersion', tab: 'content', label: 'إصدار الشروط', description: 'رقم/تاريخ إصدار الشروط والأحكام المنشورة.', status: 'enforced', schema: text(40), default: '', public: true, read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings'], proof: 'admin-content.flow.test + system-settings.pg.test (public values, versioned save, audit)', pages: ['P-AD-020'] },
	{ key: 'privacyVersion', tab: 'content', label: 'إصدار الخصوصية', description: 'رقم/تاريخ إصدار سياسة الخصوصية.', status: 'enforced', schema: text(40), default: '', public: true, read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings'], proof: 'admin-content.flow.test + system-settings.pg.test (public values, versioned save, audit)', pages: ['P-AD-020'] },
	{ key: 'termsContent', tab: 'content', label: 'نص الشروط والأحكام', description: 'النص المنشور للشروط.', status: 'enforced', schema: text(60000), default: '', public: true, read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings'], proof: 'admin-content.flow.test + system-settings.pg.test (public values, versioned save, audit)', pages: ['P-AD-020'] },
	{ key: 'privacyContent', tab: 'content', label: 'نص سياسة الخصوصية', description: 'النص المنشور للخصوصية.', status: 'enforced', schema: text(60000), default: '', public: true, read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings'], proof: 'admin-content.flow.test + system-settings.pg.test (public values, versioned save, audit)', pages: ['P-AD-020'] },
	// ───────────── ai (inventory only) ─────────────
	{ key: 'aiEngineEnabled', tab: 'ai', label: 'تفعيل محرك AI', description: 'التصنيف والمطابقة والتوصيات التلقائية.', status: 'blocked', reason: AI_SCOPE, read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'aiConfidenceThreshold', tab: 'ai', label: 'عتبة الثقة للقرارات التلقائية', description: 'نسبة الثقة المطلوبة لتنفيذ إجراء تلقائي.', status: 'blocked', reason: AI_SCOPE, unit: '%', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020'] },
	{ key: 'aiDisputeArbitration', tab: 'ai', label: 'AI تحكيم النزاعات', description: 'السماح لـ AI باقتراح قرارات النزاعات.', status: 'blocked', reason: AI_SCOPE, read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'aiFraudDetection', tab: 'ai', label: 'AI كشف الاحتيال', description: 'رصد الأنماط المشبوهة تلقائيًا.', status: 'blocked', reason: AI_SCOPE, read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'aiDisclosureBanner', tab: 'ai', label: 'الإفصاح عن AI', description: 'إظهار بنر AI Disclosure في كل صفحة.', status: 'blocked', reason: AI_SCOPE, read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020'] },
	{ key: 'aiMatchEngine', tab: 'ai', label: 'AI Match Engine / Recommendations / Content Moderation', description: 'محركات المطابقة والتوصيات وفلترة المحتوى.', status: 'blocked', reason: AI_SCOPE, read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'aiMatchMinimum', tab: 'ai', label: 'دقة المطابقة المقبولة', description: 'أدنى نسبة مطابقة تظهر للمستخدم.', status: 'blocked', reason: AI_SCOPE, unit: '%', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	// ───────────── notifications ─────────────
	{ key: 'channelInApp', tab: 'notifications', label: 'إشعارات داخل النظام', description: 'دائمة التفعيل.', status: 'readonly', reason: 'قناة النظام الأساسية؛ لا تُعطَّل.', read: 'settings.view', write: 'SUPER', consumers: ['notification.service'], pages: ['P-AD-021'], current: () => ({ value: true, source: 'قناة أساسية' }) },
	{ key: 'channelEmail', tab: 'notifications', label: 'إشعارات البريد الإلكتروني', description: 'إرسال إيميلات للمستخدمين عند الأحداث المهمة.', status: 'blocked', reason: 'لا يوجد مفتاح منصّة عام: البريد يحمل رموز الدخول الإلزامية، وتعطيله يمنع الدخول. التفضيل الفردي لكل مستخدم قائم ومحترم أصلًا.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'channelPush', tab: 'notifications', label: 'إشعارات الجوال (Push)', description: 'إرسال إشعارات للتطبيق المحمول.', status: 'blocked', reason: 'قناة Push غير منفّذة في الخادم.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'channelSms', tab: 'notifications', label: 'إشعارات SMS', description: 'رسائل نصية.', status: 'blocked', reason: 'مزوّد SMS غير منفّذ (SMS_PROVIDER_IMPLEMENTED=false).', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'channelWhatsapp', tab: 'notifications', label: 'إشعارات WhatsApp Business', description: 'واتساب للأعمال.', status: 'blocked', reason: 'لا يوجد تنفيذ لهذه القناة.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'adminDisputeAlerts', tab: 'notifications', label: 'إشعارات النزاعات للإدارة', description: 'تنبيه فوري عند فتح نزاع جديد.', status: 'readonly', reason: 'تنبيهات الإدارة تصل داخل النظام لمن يملك صلاحية الحدث (مفروضة بالصلاحيات)، ولا مفتاح عام لتعطيلها.', read: 'settings.view', write: 'SUPER', consumers: ['admin-notifications.service'], pages: ['P-AD-020'], current: () => ({ value: true, source: 'مفروضة بصلاحيات الأحداث' }) },
	{ key: 'adminNotificationEmail', tab: 'notifications', label: 'بريد الإشعارات الإدارية', description: 'عنوان يستقبل تنبيهات الإدارة.', status: 'blocked', reason: 'القيمة كانت تُحفظ دون أي مستهلك لها في الخادم، فلا تُعدَّل من هنا حتى يُنفَّذ إرسال بريد للإدارة (قرار). القيمة المحفوظة سابقًا محفوظة ولم تُمسّ.', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020'] },
	{ key: 'smtp', tab: 'notifications', label: 'خادم البريد (SMTP)', description: 'الخادم والمنفذ والبريد المُرسِل.', status: 'readonly', reason: 'إعدادات SMTP أسرار تُدار في بيئة الخادم فقط؛ لا تُخزَّن في قاعدة البيانات ولا تُعرض قيمها.', read: 'SUPER', write: 'SUPER', consumers: ['utils/mail.transporter'], pages: ['P-AD-021'], current: () => ({ value: { configured: !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS, senderConfigured: !!process.env.SMTP_FROM }, source: 'متغيرات بيئة الخادم (حالة فقط)' }) },
	// ───────────── security ─────────────
	{ key: 'sessionIdleMinutes', tab: 'security', label: 'مدة انتهاء الجلسة (من آخر نشاط)', description: '0 = بلا انتهاء بسبب الخمول (الجلسة تنتهي بعد 7 أيام كالمعتاد). عند ضبطها تُنهى الجلسات الخاملة أطول من هذه المدة عند طلبها التالي، ومنها الجلسات القائمة الآن.', status: 'enforced',
		schema: z.number().int().refine(v => v === 0 || (v >= SESSION_IDLE_ALLOWED.min && v <= SESSION_IDLE_ALLOWED.max), `0 أو بين ${SESSION_IDLE_ALLOWED.min} و${SESSION_IDLE_ALLOWED.max} دقيقة`), default: 0, unit: 'دقيقة',
		read: 'SUPER', write: 'SUPER', effect: 'within-5s', consumers: ['services/session.service validateOrRegister (كل طلب موثّق)'], proof: 'system-settings.pg.test: idle session timeout is enforced on the next request', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'minPasswordLength', tab: 'security', label: 'الحد الأدنى لطول كلمة المرور', description: 'عدد الأحرف الدنيا.', status: 'readonly', reason: 'ثابت مفروض في مدقّقات التسجيل وإعادة التعيين (utils/auth-password-policy)، ويمسّ كل الحسابات؛ جعله إعدادًا يحتاج قرارًا بأثره على الحسابات القائمة.', read: 'SUPER', write: 'SUPER', consumers: ['utils/auth-password-policy'], pages: ['P-AD-021'], current: () => ({ value: 8, source: 'AUTH_PASSWORD_MIN_LENGTH في الكود' }) },
	{ key: 'loginProtection', tab: 'security', label: 'حدود محاولات الدخول وحظر IP', description: 'الحد الأقصى للمحاولات قبل الإيقاف المؤقت.', status: 'readonly', reason: 'الحماية الفعلية تأخير تصاعدي وحدود معدّل من متغيرات الخادم (RL_*) وليست «قفل حساب بعد N محاولة»؛ لا يوجد مفتاح يطابق التصميم دون تغيير سلوك الحماية.', read: 'SUPER', write: 'SUPER', consumers: ['middlewares/rate-limit.middleware'], pages: ['P-AD-020', 'P-AD-021'], current: () => ({ value: 'مفعّلة (تأخير تصاعدي + حدود معدّل)', source: 'متغيرات RL_* وثوابت الخادم' }) },
	{ key: 'adminTwoFactor', tab: 'security', label: 'المصادقة الثنائية للإدارة', description: 'إلزامية لحسابات الإدارة.', status: 'blocked', reason: 'لا توجد آلية 2FA في النظام (يوجد رمز بريد عند الدخول للجميع).', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'auditLogging', tab: 'security', label: 'تسجيل سجلات التدقيق', description: 'حفظ كل إجراء إداري في السجل.', status: 'readonly', reason: 'مفعّل دائمًا ولا يمكن تعطيله (سلامة التدقيق).', read: 'settings.view', write: 'SUPER', consumers: ['utils/admin-audit', 'admin_access_audit'], pages: ['P-AD-020'], current: () => ({ value: true, source: 'دائم' }) },
	{ key: 'anomalyLock', tab: 'security', label: 'قفل الحساب عند الشذوذ', description: 'AI يرصد تسجيل الدخول المشبوه.', status: 'blocked', reason: AI_SCOPE, read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	// ───────────── finance ─────────────
	{ key: 'baseCurrency', tab: 'finance', label: 'العملة الأساسية', description: 'عملة السجلات الجديدة. لا تغيّر مبالغ أو عملات سجلات قائمة.', status: 'enforced', schema: z.enum(['USD', 'SAR']), default: 'USD', allowed: ['USD', 'SAR'],
		read: 'SUPER', write: 'SUPER', effect: 'immediate', consumers: ['فحص الجاهزية (currency-readiness) يرفض أي تغيير الآن'], proof: 'system-settings.pg.test: baseCurrency change refused with blockers', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'paymentGateway', tab: 'finance', label: 'بوابة الدفع', description: 'البوابة النشطة لمعالجة المدفوعات.', status: 'readonly', reason: 'PayPal هي البوابة الوحيدة المنفّذة؛ بوابات أخرى غير موجودة في الخادم.', read: 'SUPER', write: 'SUPER', consumers: ['paypal-finance.service'], pages: ['P-AD-020'], current: () => ({ value: 'PayPal', source: 'البوابة المنفّذة' }) },
	{ key: 'transactionFee', tab: 'finance', label: 'رسوم إتمام الصفقة', description: 'نسبة تُخصم من قيمة المشروع.', status: 'blocked', reason: FEE_POLICY, unit: '%', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'withdrawalFee', tab: 'finance', label: 'رسوم السحب', description: 'نسبة على كل سحب.', status: 'blocked', reason: FEE_POLICY, unit: '%', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'minWithdrawal', tab: 'finance', label: 'الحد الأدنى للسحب', description: 'أدنى مبلغ للسحب.', status: 'blocked', reason: FEE_POLICY, read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'escrowHoldHours', tab: 'finance', label: 'مدة احتجاز الضمان / الإفراج التلقائي', description: 'ساعات من قبول التسليم.', status: 'blocked', reason: 'الإفراج في النظام يتم بالموافقة على كل مرحلة؛ لا توجد مهمة إفراج تلقائي بعد مدة، فلا يُحفظ مفتاح بلا أثر.', unit: 'ساعة', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'clientCashback', tab: 'finance', label: 'نسبة كاش باك (طالب)', description: 'على كل مشروع مكتمل.', status: 'blocked', reason: FEE_POLICY, unit: '%', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'futureBilling', tab: 'finance', label: 'تجهيز فوترة مستقبلية (الزكاة / المرجع الحكومي)', description: 'غير مفعّل في V1.', status: 'blocked', reason: 'تجهيز مستقبلي (Phase 2) غير منفّذ.', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	// ───────────── regional ─────────────
	{ key: 'defaultTimezone', tab: 'regional', label: 'المنطقة الزمنية', description: 'المنطقة الزمنية الافتراضية للنظام.', status: 'blocked', reason: 'لا توجد طبقة عرض/تقارير موحّدة تستهلكها (التواريخ تُخزَّن UTC وتُعرض بتوقيت المتصفح)؛ يحتاج تنفيذ مستهلك قبل أن يُحفظ كإعداد.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'dateFormat', tab: 'regional', label: 'تنسيق التاريخ', description: 'طريقة عرض التواريخ.', status: 'blocked', reason: 'لا يوجد مُنسِّق تواريخ مركزي في الواجهة يستهلكه.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-020'] },
	{ key: 'calendarSystem', tab: 'regional', label: 'نظام التقويم', description: 'ميلادي أو هجري.', status: 'blocked', reason: 'لا يوجد دعم تقويم هجري في العرض.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-020'] },
	// ───────────── integrations ─────────────
	{ key: 'apiKeys', tab: 'integrations', label: 'مفاتيح API الخارجية', description: 'بوابة الفوترة، SMS، بوابة الدفع.', status: 'readonly', reason: 'المفاتيح أسرار تُدار في بيئة الخادم فقط؛ لا تُخزَّن ولا تُعرض ولا تمر بواجهة الإعدادات. يُعرض هنا «مهيّأ/غير مهيّأ» فقط.', read: 'SUPER', write: 'SUPER', consumers: ['paypal-finance.service', 'notification.service'], pages: ['P-AD-021'], current: () => ({ value: { paypal: !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET, smsProvider: false, billingGateway: false }, source: 'متغيرات بيئة الخادم (حالة فقط)' }) },
] as const;

export const SETTING_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTING_DEFS.map(d => [d.key, d]));
export const ENFORCED_KEYS = SETTING_DEFS.filter(d => d.status === 'enforced').map(d => d.key);
export const PUBLIC_KEYS = SETTING_DEFS.filter(d => d.status === 'enforced' && d.public).map(d => d.key);
export const SETTINGS_CACHE_TTL_MS = 5000;
