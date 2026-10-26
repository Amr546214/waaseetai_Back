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
	/** how each allowed value is written for people */
	labels?: Record<string, string>;
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
/** the absolute session lifetime choices: 8 / 24 / 48 hours of the design, plus 168 (7 days) which is today's behaviour and therefore the initial value */
export const SESSION_MAX_HOURS_ALLOWED = [8, 24, 48, 168] as const;

const AI_SCOPE = 'تغييرات الذكاء الاصطناعي والمزوّد والمفاتيح و Cloud Run نطاق منفصل: يُجرد هنا فقط ولا يُعدَّل تشغيله من هذه الصفحة.';

export const SETTING_DEFS: readonly SettingDef[] = [
	// ───────────── general ─────────────
	{ key: 'platformName', tab: 'general', label: 'اسم النظام', description: 'يظهر في رسائل البريد الجديدة (المرسل، الرأس، التذييل، العناوين الافتراضية) وفي واجهات التطبيق (الشعار النصي، التذييل، عناوين الدخول والتسجيل، عنوان التبويب). المستندات والرسائل التي صدرت سابقًا تبقى باسمها وقت إصدارها، ونصوص الصفحات التعريفية والقانونية تُحرَّر من محتواها.', status: 'enforced', schema: text(80).min(1, 'اسم المنصة مطلوب'), default: '', public: true,
		read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['اسم المرسل + رأس/تذييل/عنوان قوالب البريد الجديدة + العناوين الافتراضية للرسائل (utils/brand)', 'الواجهة: الشعار النصي والتذييل وعناوين الدخول والتسجيل وعنوان التبويب (brandName)', 'GET /public/settings'], proof: 'system-settings.pg.test: platformName reaches the mail sender and public settings', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'maintenanceMode', tab: 'general', label: 'وضع الصيانة', description: 'يوقف الوصول لجميع المستخدمين مؤقتًا. يبقى متاحًا: الصحة، الدخول والاستعادة، الإعدادات العامة، الإشعارات، استدعاءات الدفع الواردة ومسار إكمال دفع بدأ قبل الصيانة، وكل المنصة ولوحة الإدارة لـSuper Admin فقط (لا استثناء لباقي الموظفين).', status: 'enforced', schema: bool, default: false,
		read: 'SUPER', write: 'SUPER', effect: 'within-5s', consumers: ['middlewares/maintenance.middleware (كل طلب HTTP)'], proof: 'maintenance.middleware.test + system-settings.pg.test: maintenance is enforced on traffic', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'maintenanceBannerEnabled', tab: 'general', label: 'بنر الصيانة/الإعلان', description: 'يعرض البنر أعلى التطبيق دون إيقاف الخدمة.', status: 'enforced', schema: bool, default: false, public: true,
		read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings', 'PlatformBanner (الواجهة)'], proof: 'FE platform-banner.spec + sa-system-settings.spec', pages: ['P-AD-020'] },
	{ key: 'maintenanceBannerText', tab: 'general', label: 'نص البنر', description: 'النص الظاهر في البنر ورسالة الصيانة.', status: 'enforced', schema: text(300), default: '', public: true,
		read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings', 'PlatformBanner', 'رد 503 أثناء الصيانة'], proof: 'FE platform-banner.spec + sa-system-settings.spec', pages: ['P-AD-020'] },
	{ key: 'registrationOpen', tab: 'general', label: 'تسجيل حسابات جديدة', description: 'السماح بإنشاء حسابات جديدة. عند الإغلاق يرفض الخادم التسجيل نفسه (وليس إخفاء الزر فقط).', status: 'enforced', schema: bool, default: true, public: true,
		read: 'settings.view', write: 'SUPER', effect: 'within-5s', consumers: ['auth.service registerUser / googleAuth(register)', 'GET /public/settings (يخفي الواجهة)'], proof: 'system-settings.pg.test: registration closed => 403 REGISTRATION_CLOSED', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'supportEmail', tab: 'general', label: 'بريد الدعم', description: 'العنوان العام للتواصل مع الدعم.', status: 'enforced', schema: emailOrEmpty, default: '', public: true, read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings'], proof: 'admin-content.flow.test + system-settings.pg.test (public values, versioned save, audit)', pages: ['P-AD-020'] },
	{ key: 'supportPhone', tab: 'general', label: 'هاتف الدعم', description: 'رقم التواصل العام.', status: 'enforced', schema: phoneOrEmpty, default: '', public: true, read: 'settings.view', write: 'settings.manage', effect: 'within-5s', consumers: ['GET /public/settings'], proof: 'admin-content.flow.test + system-settings.pg.test (public values, versioned save, audit)', pages: ['P-AD-020'] },
	{ key: 'defaultLanguage', tab: 'general', label: 'اللغة الافتراضية', description: 'لغة البريد والإشعارات الموجّهة لمن لم يختر لغة تواصل بنفسه. اختيار المستخدم يتقدّم دائمًا. واجهة الويب عربية فقط حاليًا (لا توجد ترجمة إنجليزية) فلا يغيّر هذا الإعداد لغة الواجهة.', status: 'enforced',
		schema: z.enum(['ar', 'en']), default: 'ar', allowed: ['ar', 'en'], labels: { ar: 'العربية (الحالي)', en: 'English' }, public: true,
		read: 'settings.view', write: 'SUPER', effect: 'within-5s', consumers: ['notification.service resolveDelivery: لغة البريد/الإشعار عند غياب اختيار المستلم'], proof: 'system-settings.pg.test: default language reaches recipients without a saved choice', pages: ['P-AD-021'] },
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
	{ key: 'channelEmail', tab: 'notifications', label: 'إشعارات البريد الإلكتروني الاختيارية', description: 'يوقف رسائل البريد الاختيارية فقط (نسخ الإشعارات وملخص الرسائل غير المقروءة). لا تُرسل الرسالة إلا إذا كان المفتاح مفعّلًا والمستخدم قد اختار البريد في إعداداته.', status: 'enforced', schema: bool, default: true, public: true,
		read: 'settings.view', write: 'SUPER', effect: 'within-5s', consumers: ['notification.service resolveDelivery + sendNotificationMail (نسخ الإشعارات)', 'chat-digest.service runChatDigestOnce + sendDigestMail (عند التنفيذ لا عند الجدولة)', 'email.service مكافأة إكمال المشروع / نتيجة تدقيق النموذج', 'notificationPreferenceService / marketerSettingsService / providerProfile.updatePreferences: رفض تفعيل خيار البريد (409 EMAIL_CHANNEL_DISABLED_BY_PLATFORM) دون مسّ القيمة المحفوظة', 'GET/PATCH /notifications/preferences -> data.platform.emailEnabled (واجهة التفضيلات)'], proof: 'optional-email-gate.test + optional-email-gate.pg.test: platform OFF sends zero optional mail, OTP/reset still sent, stored choice untouched, deferred digest not sent', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'channelPush', tab: 'notifications', label: 'إشعارات الجوال (Push)', description: 'إرسال إشعارات للتطبيق المحمول.', status: 'blocked', reason: 'قناة Push غير منفّذة في الخادم.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'channelSms', tab: 'notifications', label: 'إشعارات SMS', description: 'رسائل نصية.', status: 'blocked', reason: 'مزوّد SMS غير منفّذ (SMS_PROVIDER_IMPLEMENTED=false).', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'channelWhatsapp', tab: 'notifications', label: 'إشعارات WhatsApp Business', description: 'واتساب للأعمال.', status: 'blocked', reason: 'لا يوجد تنفيذ لهذه القناة.', read: 'settings.view', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	{ key: 'adminDisputeAlerts', tab: 'notifications', label: 'إشعارات النزاعات للإدارة', description: 'تنبيه فوري عند فتح نزاع جديد.', status: 'readonly', reason: 'تنبيهات الإدارة تصل داخل النظام لمن يملك صلاحية الحدث (مفروضة بالصلاحيات)، ولا مفتاح عام لتعطيلها.', read: 'settings.view', write: 'SUPER', consumers: ['admin-notifications.service'], pages: ['P-AD-020'], current: () => ({ value: true, source: 'مفروضة بصلاحيات الأحداث' }) },
	{ key: 'adminNotificationEmail', tab: 'notifications', label: 'بريد الإشعارات الإدارية', description: 'صندوق بريد مؤسسي واحد يُنبَّه بالبريد عند وصول: نزاع جديد، تذكرة دعم، طلب سحب، مستند هوية. المحتوى: نوع الحدث ومعرّفه ورابط للوحة فقط، دون أي بيانات مستخدم أو مبالغ. بريد واحد كحد أقصى لكل نوع حدث في الدقيقة. منفصل عن مستلمي التنبيهات داخل النظام (تُبنى من صلاحيات الموظفين).', status: 'enforced',
		schema: z.union([z.literal(''), z.string().trim().email('البريد غير صالح').max(120)]), default: '', read: 'SUPER', write: 'SUPER', effect: 'within-5s', consumers: ['admin-notifications.service notifyAdmins -> admin-mailbox-alert.service (4 أحداث)'], proof: 'system-settings.pg.test: admin mailbox alert', pages: ['P-AD-020'] },
	{ key: 'smtp', tab: 'notifications', label: 'خادم البريد (SMTP)', description: 'الخادم والمنفذ والبريد المُرسِل.', status: 'readonly', reason: 'إعدادات SMTP أسرار تُدار في بيئة الخادم فقط؛ لا تُخزَّن في قاعدة البيانات ولا تُعرض قيمها.', read: 'SUPER', write: 'SUPER', consumers: ['utils/mail.transporter'], pages: ['P-AD-021'], current: () => ({ value: { configured: !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS, senderConfigured: !!process.env.SMTP_FROM }, source: 'متغيرات بيئة الخادم (حالة فقط)' }) },
	// ───────────── security ─────────────
	{ key: 'sessionIdleMinutes', tab: 'security', label: 'انتهاء الجلسة بسبب الخمول', description: 'دقائق بلا أي نشاط تُنهى بعدها الجلسة عند طلبها التالي. 0 = لا إنهاء بسبب الخمول (القيمة الابتدائية = السلوك الحالي). يسري على الجلسات القائمة أيضًا، فيُعرض قبل الحفظ عدد الجلسات التي ستنتهي فورًا.', status: 'enforced',
		schema: z.number().int().refine(v => v === 0 || (v >= SESSION_IDLE_ALLOWED.min && v <= SESSION_IDLE_ALLOWED.max), `0 أو بين ${SESSION_IDLE_ALLOWED.min} و${SESSION_IDLE_ALLOWED.max} دقيقة`), default: 0, unit: 'دقيقة',
		read: 'SUPER', write: 'SUPER', effect: 'within-5s', consumers: ['services/session.service validateOrRegister (كل طلب موثّق + اتصال socket)'], proof: 'system-settings.pg.test: idle session timeout / impact preview', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'sessionMaxHours', tab: 'security', label: 'المدة القصوى المطلقة للجلسة', description: 'أقصى عمر لجلسة الدخول بالساعات مهما كان نشاطها (غير الخمول). القيمة الابتدائية 168 ساعة (7 أيام) = السلوك الحالي. يسري على الجلسات الجديدة فقط؛ الجلسات القائمة تحتفظ بمدتها ولا يخرج أحد بتعديلها.', status: 'enforced',
		schema: z.number().int().refine(v => (SESSION_MAX_HOURS_ALLOWED as readonly number[]).includes(v), `اختر من: ${SESSION_MAX_HOURS_ALLOWED.join('، ')} ساعة`), default: 168, allowed: SESSION_MAX_HOURS_ALLOWED, unit: 'ساعة',
		read: 'SUPER', write: 'SUPER', effect: 'new-sessions', consumers: ['utils/access-token issueAccessToken (JWT + انتهاء الجلسة عند الدخول)'], proof: 'system-settings.pg.test: sessionMaxHours reaches new tokens only', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'minPasswordLength', tab: 'security', label: 'الحد الأدنى لطول كلمة المرور', description: 'عدد الأحرف الدنيا.', status: 'readonly', reason: 'ثابت مفروض في مدقّقات التسجيل وإعادة التعيين (utils/auth-password-policy)، ويمسّ كل الحسابات؛ جعله إعدادًا يحتاج قرارًا بأثره على الحسابات القائمة.', read: 'SUPER', write: 'SUPER', consumers: ['utils/auth-password-policy'], pages: ['P-AD-021'], current: () => ({ value: 8, source: 'AUTH_PASSWORD_MIN_LENGTH في الكود' }) },
	{ key: 'loginProtection', tab: 'security', label: 'حدود محاولات الدخول وحظر IP', description: 'الحد الأقصى للمحاولات قبل الإيقاف المؤقت.', status: 'readonly', reason: 'الحماية الفعلية تأخير تصاعدي وحدود معدّل من متغيرات الخادم (RL_*) وليست «قفل حساب بعد N محاولة»؛ لا يوجد مفتاح يطابق التصميم دون تغيير سلوك الحماية.', read: 'SUPER', write: 'SUPER', consumers: ['middlewares/rate-limit.middleware'], pages: ['P-AD-020', 'P-AD-021'], current: () => ({ value: 'مفعّلة (تأخير تصاعدي + حدود معدّل)', source: 'متغيرات RL_* وثوابت الخادم' }) },
	{ key: 'adminTwoFactor', tab: 'security', label: 'المصادقة الثنائية للإدارة', description: 'إلزامية لحسابات الإدارة.', status: 'blocked', reason: 'لا توجد آلية 2FA في النظام (يوجد رمز بريد عند الدخول للجميع).', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'auditLogging', tab: 'security', label: 'تسجيل سجلات التدقيق', description: 'حفظ كل إجراء إداري في السجل.', status: 'readonly', reason: 'مفعّل دائمًا ولا يمكن تعطيله (سلامة التدقيق).', read: 'settings.view', write: 'SUPER', consumers: ['utils/admin-audit', 'admin_access_audit'], pages: ['P-AD-020'], current: () => ({ value: true, source: 'دائم' }) },
	{ key: 'anomalyLock', tab: 'security', label: 'قفل الحساب عند الشذوذ', description: 'AI يرصد تسجيل الدخول المشبوه.', status: 'blocked', reason: AI_SCOPE, read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-021'] },
	// ───────────── finance ─────────────
	{ key: 'baseCurrency', tab: 'finance', label: 'العملة الأساسية', description: 'عملة السجلات الجديدة.', status: 'blocked', reason: 'تعدد العملات مؤجَّل: المنصة بالدولار الأمريكي (USD) في هذا الإصدار، ولا يُحفظ مفتاح بلا أثر.', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'paymentGateway', tab: 'finance', label: 'بوابة الدفع', description: 'البوابة النشطة لمعالجة المدفوعات.', status: 'readonly', reason: 'PayPal هي البوابة الوحيدة المنفّذة؛ بوابات أخرى غير موجودة في الخادم.', read: 'SUPER', write: 'SUPER', consumers: ['paypal-finance.service'], pages: ['P-AD-020'], current: () => ({ value: 'PayPal', source: 'البوابة المنفّذة' }) },
	{ key: 'escrowHoldHours', tab: 'finance', label: 'مدة احتجاز الضمان / الإفراج التلقائي', description: 'ساعات من قبول التسليم.', status: 'blocked', reason: 'الإفراج في النظام يتم بالموافقة على كل مرحلة؛ لا توجد مهمة إفراج تلقائي بعد مدة، فلا يُحفظ مفتاح بلا أثر.', unit: 'ساعة', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'futureBilling', tab: 'finance', label: 'تجهيز فوترة مستقبلية (الزكاة / المرجع الحكومي)', description: 'غير مفعّل في V1.', status: 'blocked', reason: 'تجهيز مستقبلي (Phase 2) غير منفّذ.', read: 'SUPER', write: 'SUPER', consumers: [], pages: ['P-AD-020', 'P-AD-021'] },
	// ───────────── regional ─────────────
	{ key: 'defaultTimezone', tab: 'regional', label: 'المنطقة الزمنية', description: 'المنطقة التي تُعرض بها الأوقات في الواجهات (لمن لم يحفظ منطقة خاصة به) وتُقطع بها أيام وشهور تقارير الإدارة ويُكتب بها وقت ملفات CSV. الأوقات المخزّنة تبقى UTC. «حسب جهاز المستخدم» هو السلوك الحالي.', status: 'enforced',
		schema: z.enum(['browser', 'Asia/Riyadh', 'UTC']), default: 'browser', allowed: ['browser', 'Asia/Riyadh', 'UTC'], labels: { browser: 'حسب جهاز المستخدم (الحالي)', 'Asia/Riyadh': 'Asia/Riyadh (GMT+3)', UTC: 'UTC' }, public: true,
		read: 'settings.view', write: 'SUPER', effect: 'within-5s', consumers: ['الواجهة: DATE_PIPE_DEFAULT_OPTIONS ومُنسِّق التواريخ (تفضيل المزوّد/الوسيط الشخصي يتقدّم)', 'utils/platform-time: نوافذ شهر/يوم تقارير الإدارة (admin-dashboard / security / specialties / users)', 'CSV: عمود الوقت المحلي'], proof: 'platform-time.test + system-settings.pg.test (regional) + FE regional.spec', pages: ['P-AD-020', 'P-AD-021'] },
	{ key: 'dateFormat', tab: 'regional', label: 'تنسيق التاريخ', description: 'يطبّق على التواريخ والأوقات المعروضة عبر المُنسِّق المركزي (wsDate). «حسب الصفحة» يترك لكل صفحة تنسيقها الحالي (السلوك الحالي).', status: 'enforced',
		schema: z.enum(['legacy', 'DD/MM/YYYY', 'YYYY-MM-DD']), default: 'legacy', allowed: ['legacy', 'DD/MM/YYYY', 'YYYY-MM-DD'], labels: { legacy: 'حسب الصفحة (الحالي)', 'DD/MM/YYYY': 'DD/MM/YYYY', 'YYYY-MM-DD': 'YYYY-MM-DD' }, public: true,
		read: 'settings.view', write: 'SUPER', effect: 'within-5s', consumers: ['الواجهة: pipe wsDate (كل التواريخ الرقمية في الصفحات)'], proof: 'FE regional.spec + ws-date.pipe.spec', pages: ['P-AD-020'] },
	{ key: 'calendarSystem', tab: 'regional', label: 'نظام التقويم', description: 'ميلادي أو هجري (أم القرى) للتواريخ المعروضة عبر المُنسِّق المركزي. الأوقات المخزّنة لا تتغير.', status: 'enforced',
		schema: z.enum(['gregorian', 'hijri']), default: 'gregorian', allowed: ['gregorian', 'hijri'], labels: { gregorian: 'ميلادي (الحالي)', hijri: 'هجري' }, public: true,
		read: 'settings.view', write: 'SUPER', effect: 'within-5s', consumers: ['الواجهة: pipe wsDate'], proof: 'FE ws-date.pipe.spec', pages: ['P-AD-020'] },
	// ───────────── integrations ─────────────
	{ key: 'apiKeys', tab: 'integrations', label: 'مفاتيح API الخارجية', description: 'بوابة الفوترة، SMS، بوابة الدفع.', status: 'readonly', reason: 'المفاتيح أسرار تُدار في بيئة الخادم فقط؛ لا تُخزَّن ولا تُعرض ولا تمر بواجهة الإعدادات. يُعرض هنا «مهيّأ/غير مهيّأ» فقط.', read: 'SUPER', write: 'SUPER', consumers: ['paypal-finance.service', 'notification.service'], pages: ['P-AD-021'], current: () => ({ value: { paypal: !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET, smsProvider: false, billingGateway: false }, source: 'متغيرات بيئة الخادم (حالة فقط)' }) },
] as const;

export const SETTING_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTING_DEFS.map(d => [d.key, d]));
export const ENFORCED_KEYS = SETTING_DEFS.filter(d => d.status === 'enforced').map(d => d.key);
export const PUBLIC_KEYS = SETTING_DEFS.filter(d => d.status === 'enforced' && d.public).map(d => d.key);
export const SETTINGS_CACHE_TTL_MS = 5000;
