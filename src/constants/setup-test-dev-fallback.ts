// DEV-ONLY generic calibration set for the onboarding setup test.
//
// NOT specialty-specific and NEVER an AI result. It is used by sockets/setup-test.gateway.ts ONLY when process.env.SETUP_TEST_DEV_FALLBACK is exactly
// the string 'true' (default OFF; do not add the flag to any committed env / config / docker file) AND the WaseetAI call actually failed. Answers are
// graded locally from the user's real answers (score = correct / total * 100). The correct option is kept server-side and is never emitted.
import { SPECIALTY_TEST_QUESTION_COUNT } from './specialty-test';

export interface SetupTestFallbackQuestion {
	id: string;
	textAr: string;
	options: Array<{ id: string; text: string }>;
	correctOptionId: string;
}

/** Exactly the string 'true' turns the fallback on; 'TRUE', '1', 'yes', unset, anything else = off. */
export const isSetupTestDevFallbackEnabled = (): boolean => process.env.SETUP_TEST_DEV_FALLBACK === 'true';

// the authored order puts the correct option at index `correct`; it is moved to a varying position so the key is not always the same letter
const q = (id: number, textAr: string, options: [string, string, string, string], correct: 0 | 1 | 2 | 3): SetupTestFallbackQuestion => {
	const texts = [...options];
	const target = (id * 3 + 1) % 4;
	[texts[correct], texts[target]] = [texts[target], texts[correct]];
	return { id: String(id), textAr, options: texts.map((text, i) => ({ id: String.fromCharCode(97 + i), text })), correctOptionId: String.fromCharCode(97 + target) };
};

export const SETUP_TEST_DEV_FALLBACK_QUESTIONS: readonly SetupTestFallbackQuestion[] = [
	q(1, 'قبل أن تبدأ العمل على طلب عميل جديد، ما الخطوة الأهم؟', ['البدء فوراً دون أسئلة لتوفير الوقت', 'توضيح نطاق العمل والمخرجات المطلوبة بالتفصيل', 'تحديد السعر فقط وتجاهل التفاصيل', 'ترك العميل يكتشف النطاق أثناء التنفيذ'], 1),
	q(2, 'عندما يكون طلب العميل غير واضح، ما التصرف الأنسب؟', ['افتراض ما يقصده وتنفيذه', 'طرح أسئلة محددة لتوضيح المطلوب قبل التنفيذ', 'تأجيل الرد حتى يعيد العميل الشرح', 'تنفيذ أبسط نسخة ممكنة وتسليمها'], 1),
	q(3, 'ما أفضل طريقة للتواصل مع العميل أثناء تنفيذ المشروع؟', ['التواصل فقط عند التسليم النهائي', 'تحديثات منتظمة وواضحة عن سير العمل', 'التواصل فقط عند حدوث مشكلة كبيرة', 'تجنب التواصل لتجنب الأسئلة'], 1),
	q(4, 'اقترب موعد التسليم وتبين أنك ستتأخر، ماذا تفعل؟', ['تسليم العمل متأخراً دون إخبار العميل', 'إبلاغ العميل مبكراً مع موعد جديد واقعي', 'تسليم عمل ناقص دون توضيح', 'التوقف عن الرد حتى تنتهي'], 1),
	q(5, 'كيف تقدّر مدة تنفيذ مشروع جديد؟', ['اختيار أقصر مدة لإرضاء العميل', 'تقسيم العمل إلى مهام وتقدير كل مهمة مع هامش للمراجعات', 'الاعتماد على التخمين العام', 'نسخ مدة مشروع سابق دون النظر لاختلاف التفاصيل'], 1),
	q(6, 'ما الغرض من مراجعة الجودة قبل التسليم؟', ['إطالة مدة المشروع', 'التأكد من مطابقة العمل للمتطلبات وتقليل الأخطاء', 'إرضاء الذات فقط', 'لا حاجة لها إذا كان العمل بسيطاً'], 1),
	q(7, 'أرسل العميل ملاحظات على العمل المسلّم، كيف تتعامل معها؟', ['رفضها كلها لأنك واثق من عملك', 'قراءتها بعناية وتطبيق ما يتوافق مع المتطلبات المتفق عليها وتوضيح ما يخرج عنها', 'تجاهلها وانتظار موافقة تلقائية', 'الانسحاب من المشروع فوراً'], 1),
	q(8, 'طلب منك عميل مهمة تتجاوز خبرتك الحالية، ما التصرف الأمين؟', ['الموافقة والتظاهر بالخبرة', 'توضيح حدود خبرتك بصدق واقتراح ما تستطيع تنفيذه', 'الموافقة ثم الاعتماد على غيرك دون إخبار العميل', 'إعطاء وعود كبيرة لكسب المشروع'], 1),
	q(9, 'ما الأساس الأسلم لتسعير خدمة جديدة؟', ['اختيار أقل سعر في السوق دائماً', 'حساب الجهد والوقت والخبرة المطلوبة مقارنة بأسعار مشابهة', 'رفع السعر عشوائياً', 'السؤال عن ميزانية العميل ثم الطلب بالمبلغ نفسه دائماً'], 1),
	q(10, 'ما معنى أن يكون التسليم احترافياً؟', ['إرسال ملف واحد دون شرح', 'تسليم المخرجات المتفق عليها منظمة مع شرح موجز لما تم', 'التسليم قبل الموعد دون مراجعة', 'التسليم عبر قنوات غير متفق عليها'], 1),
	q(11, 'طلب العميل إضافة ميزة جديدة بعد الاتفاق على النطاق، ما الأنسب؟', ['تنفيذها مجاناً دائماً', 'مناقشة أثرها على السعر والمدة والاتفاق عليها كتابياً', 'رفضها دون نقاش', 'تنفيذها دون إبلاغ العميل بأثرها'], 1),
	q(12, 'لماذا يُعد توثيق الاتفاق مع العميل مهماً؟', ['لا أهمية له', 'يحمي حقوق الطرفين ويمنع سوء الفهم', 'يؤخر المشروع فقط', 'مطلوب فقط في المشاريع الكبيرة جداً'], 1),
	q(13, 'عند ارتكابك خطأ في العمل بعد التسليم، ما التصرف الأفضل؟', ['إخفاء الخطأ وانتظار اكتشافه', 'الاعتراف به وتصحيحه بسرعة وإبلاغ العميل', 'إلقاء اللوم على العميل', 'تجاهل الرسائل بشأنه'], 1),
	q(14, 'كيف تحافظ على سرية بيانات العميل؟', ['مشاركتها مع زملاء دون إذن لطلب الرأي', 'استخدامها فقط لغرض المشروع وعدم مشاركتها دون موافقة', 'نشر أجزاء منها كنموذج أعمال دون إذن', 'الاحتفاظ بنسخ دون حاجة'], 1),
	q(15, 'ما الذي يبني سمعة جيدة لمقدم الخدمة على المدى الطويل؟', ['وعود كبيرة بلا التزام', 'الالتزام بالمواعيد وجودة ثابتة وتواصل صادق', 'تقليل الأسعار باستمرار', 'التركيز على عدد المشاريع فقط'], 1),
];

// guard the invariant at import time: a wrong bank must fail loudly in tests, never serve a short / broken test
if (SETUP_TEST_DEV_FALLBACK_QUESTIONS.length !== SPECIALTY_TEST_QUESTION_COUNT) throw new Error('setup-test dev fallback bank must have exactly SPECIALTY_TEST_QUESTION_COUNT questions');
