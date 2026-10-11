// Provider skills catalog: the ONLY skills a provider can pick, keyed by the marketplace main specialty (Category.slug).
//
// Source and logic (no DB seed, no migration):
//  - The keys are the 19 Category slugs of prisma/seed-marketplace-taxonomy.ts (the same taxonomy the marketplace and the registration wizard read).
//  - Each list is the set of standard market skills / tools / methods named by, or directly implied by, the specialties of that category
//    (for example the "تطوير الواجهات الأمامية" description names React/Vue/Angular). A skill appears under a category only when it belongs to
//    that field; nothing is cross-linked "just in case". A skill used by two fields (e.g. Python) is listed in both.
//  - Rows of the Skill table are created lazily, only for a name from this catalog that a provider actually picks (see skills-catalog.service.ts),
//    so no seed is needed and the table can never contain a name outside the catalog.
//  - This file is the single editable source: adding a skill = one line here.

export interface SkillsCatalog { [categorySlug: string]: readonly string[] }

export const SKILLS_CATALOG: SkillsCatalog = {
  'programming-development': [
    'HTML', 'CSS', 'JavaScript', 'TypeScript', 'React', 'Vue.js', 'Angular', 'Next.js', 'Node.js', 'Express', 'NestJS', 'Python', 'Django', 'FastAPI', 'Flask',
    'PHP', 'Laravel', 'Java', 'Spring Boot', 'C#', '.NET', 'Go', 'Ruby on Rails', 'Swift', 'Kotlin', 'Flutter', 'React Native', 'Electron', 'REST API', 'GraphQL',
    'SQL', 'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'WordPress', 'Shopify', 'Git', 'اختبار البرمجيات', 'مراجعة الكود', 'تصميم البنية التقنية',
  ],
  'ai-data': [
    'Python', 'R', 'SQL', 'Pandas', 'NumPy', 'Scikit-learn', 'TensorFlow', 'PyTorch', 'Keras', 'تعلم الآلة', 'التعلم العميق', 'معالجة اللغة الطبيعية', 'الرؤية الحاسوبية',
    'النماذج اللغوية الكبيرة', 'الذكاء الاصطناعي التوليدي', 'هندسة الأوامر', 'LangChain', 'أنظمة التوصية', 'تحليل البيانات', 'تصور البيانات', 'Power BI', 'Tableau',
    'Apache Spark', 'Airflow', 'خطوط ETL', 'مستودعات البيانات', 'MLOps', 'Excel',
  ],
  'design-creative': [
    'Adobe Photoshop', 'Adobe Illustrator', 'Adobe InDesign', 'Figma', 'Adobe XD', 'Sketch', 'تصميم واجهات المستخدم', 'تجربة المستخدم UX', 'تصميم الشعارات', 'الهوية البصرية',
    'تصميم الجرافيك', 'الرسم التوضيحي', 'تصميم الأيقونات', 'الخطوط والطباعة', 'تصميم المطبوعات', 'تصميم التغليف', 'تصميم السوشيال ميديا', 'تصميم العروض التقديمية',
    'الإنفوجرافيك', 'Blender', 'Cinema 4D', 'تصميم الشخصيات', 'أنظمة التصميم', 'النماذج الأولية', 'Canva',
  ],
  'digital-marketing': [
    'تحسين محركات البحث SEO', 'Google Ads', 'إعلانات PPC', 'Meta Ads', 'TikTok Ads', 'تسويق وسائل التواصل', 'تسويق المحتوى', 'التسويق عبر البريد الإلكتروني', 'Mailchimp',
    'التسويق عبر المؤثرين', 'التسويق بالعمولة', 'استراتيجية التسويق', 'Growth Hacking', 'تحسين معدل التحويل CRO', 'Google Analytics', 'إدارة المجتمعات', 'تسويق العلامة التجارية',
    'تحسين البحث المحلي', 'أتمتة التسويق', 'HubSpot', 'أبحاث الكلمات المفتاحية',
  ],
  'writing-translation': [
    'كتابة الإعلانات', 'كتابة المحتوى', 'كتابة المدونات', 'الكتابة التقنية', 'الكتابة الإبداعية', 'التحرير والتدقيق اللغوي', 'الترجمة العربية', 'الترجمة الإنجليزية', 'التوطين',
    'التفريغ الصوتي', 'الترجمة النصية للفيديو', 'كتابة المنح والمقترحات', 'كتابة السير الذاتية', 'كتابة البيانات الصحفية', 'كتابة السكربتات', 'كتابة SEO', 'البحث وجمع المعلومات',
  ],
  'business-consulting': [
    'استراتيجية الأعمال', 'استشارات الإدارة', 'خطط العمل', 'أبحاث السوق', 'استشارات العمليات', 'إدارة المشاريع', 'Agile', 'Scrum', 'إدارة التغيير', 'استشارات الموارد البشرية',
    'التوظيف واكتساب المواهب', 'التصميم التنظيمي', 'تحسين العمليات', 'إدارة المخاطر', 'استشارات الشركات الناشئة', 'تحليل الأعمال', 'تحليل SWOT', 'مؤشرات الأداء KPI', 'Jira',
  ],
  'finance-accounting': [
    'مسك الدفاتر', 'المحاسبة المالية', 'التخطيط المالي', 'الاستشارات الضريبية', 'إعداد الإقرارات الضريبية', 'المراجعة والتدقيق', 'إعداد الرواتب', 'النمذجة المالية', 'الميزانيات والتوقعات',
    'استشارات الاستثمار', 'تمويل الشركات', 'الذمم الدائنة والمدينة', 'التقارير المالية', 'محاسبة التكاليف', 'إدارة الخزانة', 'Excel', 'QuickBooks', 'Xero', 'IFRS',
  ],
  'engineering-architecture': [
    'AutoCAD', 'Revit', 'SketchUp', '3ds Max', 'Lumion', 'التصميم المعماري', 'الهندسة الإنشائية', 'الهندسة المدنية', 'الهندسة الكهربائية', 'الهندسة الميكانيكية', 'هندسة التكييف والتهوية',
    'هندسة الصحي والسباكة', 'العمارة الداخلية', 'تنسيق الحدائق', 'التخطيط الحضري', 'نمذجة معلومات البناء BIM', 'قياس الكميات', 'إدارة الإنشاءات', 'التصميم المستدام', 'ETABS', 'SAP2000',
  ],
  'video-audio': [
    'Adobe Premiere Pro', 'Final Cut Pro', 'DaVinci Resolve', 'After Effects', 'تحرير الفيديو', 'إنتاج الفيديو', 'الموشن جرافيك', 'الأنيميشن', 'التعليق الصوتي', 'تحرير الصوت', 'Adobe Audition',
    'إنتاج الموسيقى', 'Logic Pro', 'Ableton Live', 'تصميم الصوت', 'إنتاج البودكاست', 'المكساج والماسترينغ', 'تحرير فيديو يوتيوب', 'الفيديو القصير', 'تدرج الألوان', 'البث المباشر',
  ],
  'education-training': [
    'التدريس عبر الإنترنت', 'تعليم اللغات', 'تطوير المناهج', 'إنشاء الدورات الإلكترونية', 'التدريب المؤسسي', 'التدريب المهني', 'التحضير للاختبارات', 'الكتابة الأكاديمية', 'تعليم STEM',
    'تعليم البرمجة', 'تعليم الأطفال', 'التصميم التعليمي', 'مهارات الدراسة', 'الإرشاد المهني', 'Moodle', 'Zoom', 'Articulate Storyline',
  ],
  'admin-support': [
    'المساعد الافتراضي', 'إدخال البيانات', 'إدارة المواعيد والتقويم', 'إدارة البريد الإلكتروني', 'تخطيط السفر', 'تنسيق المستندات', 'التفريغ النصي', 'خدمات البحث', 'توليد العملاء المحتملين',
    'إدارة CRM', 'جداول البيانات', 'Excel', 'Google Sheets', 'تنظيم الملفات', 'Microsoft Word', 'Notion', 'خدمة المساعد الشخصي',
  ],
  'customer-support': [
    'خدمة العملاء عبر الدردشة', 'خدمة العملاء عبر الهاتف', 'الدعم عبر البريد الإلكتروني', 'دعم التذاكر', 'الدعم الفني', 'إدارة مكتب المساعدة', 'قاعدة المعرفة', 'إدارة المجتمعات',
    'تأهيل العملاء', 'معالجة الشكاوى', 'الدعم متعدد اللغات', 'الدعم عبر السوشيال ميديا', 'دعم إدارة الطلبات', 'الاسترداد والإرجاع', 'Zendesk', 'Freshdesk', 'Intercom',
  ],
  'e-commerce': [
    'إعداد المتاجر الإلكترونية', 'Shopify', 'WooCommerce', 'سلة', 'زد', 'إدراج المنتجات', 'كتابة أوصاف المنتجات', 'إدارة المخزون', 'تنفيذ الطلبات', 'الدروبشيبينغ', 'Amazon FBA',
    'إدراج المنتجات في الأسواق', 'تصوير المنتجات', 'تحسين التحويل للمتاجر', 'SEO للمتاجر', 'إعلانات الأسواق', 'إدارة المرتجعات', 'البحث عن الموردين', 'تحليلات التجارة الإلكترونية',
  ],
  'no-code-automation': [
    'Bubble', 'Webflow', 'Airtable', 'Zapier', 'Make', 'Notion', 'Glide', 'Softr', 'Framer', 'Salesforce', 'HubSpot', 'أتمتة سير العمل', 'دمج API بدون كود', 'أتمتة العمليات',
    'الشات بوت', 'n8n', 'Power Automate',
  ],
  'cybersecurity': [
    'اختبار الاختراق', 'تقييم الثغرات', 'التدقيق الأمني', 'الاستجابة للحوادث', 'استخبارات التهديدات', 'البنية الأمنية', 'أمن السحابة', 'أمن التطبيقات', 'أمن الشبكات', 'الامتثال GDPR',
    'ISO 27001', 'التوعية الأمنية', 'SIEM', 'إدارة الهوية والوصول', 'حماية البيانات والخصوصية', 'تحليل البرمجيات الخبيثة', 'Kali Linux', 'Burp Suite', 'Wireshark', 'OWASP',
  ],
  'devops-cloud': [
    'DevOps', 'CI/CD', 'Jenkins', 'GitHub Actions', 'GitLab CI', 'AWS', 'Google Cloud', 'Microsoft Azure', 'Kubernetes', 'Docker', 'Terraform', 'Ansible', 'أتمتة البنية التحتية', 'الترحيل إلى السحابة',
    'الهندسة السحابية', 'SRE', 'Prometheus', 'Grafana', 'Serverless', 'تحسين تكاليف السحابة', 'إدارة قواعد البيانات', 'Linux', 'Nginx',
  ],
  'games': [
    'Unity', 'Unreal Engine', 'C#', 'C++', 'Godot', 'تطوير ألعاب الجوال', 'فن الألعاب', 'نمذجة الألعاب ثلاثية الأبعاد', 'Blender', 'أنيميشن الألعاب', 'تصميم المستويات', 'تصميم واجهات الألعاب',
    'موسيقى وصوت الألعاب', 'كتابة سيناريو الألعاب', 'اختبار الألعاب QA', 'الواقع المعزز والافتراضي', 'تحقيق الدخل من الألعاب', 'الألعاب متعددة اللاعبين',
  ],
  'legal-services': [
    'قانون العقود', 'قانون الشركات', 'الملكية الفكرية', 'قانون العمل', 'القانون الضريبي', 'قانون الخصوصية', 'صياغة الشروط والسياسات', 'القانون التجاري', 'تسوية المنازعات', 'قانون الهجرة',
    'قانون العقارات', 'قانون الأسرة', 'الاستشارات القانونية', 'البحوث القانونية', 'الامتثال التنظيمي', 'مراجعة العقود',
  ],
  'lifestyle-misc': [
    'تدريب الحياة', 'تدريب الصحة والعافية', 'التغذية وتخطيط الحمية', 'تدريب اللياقة', 'التنظيم الشخصي', 'تنظيم الفعاليات', 'استشارات السفر', 'العلامة الشخصية', 'تدريب المسار المهني',
    'التصوير الفوتوغرافي', 'تنظيم المنزل', 'تدريب العلاقات', 'اليقظة والتأمل',
  ],
};

export const SKILL_NAME_MAX = 40;

const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

/** Skills offered for one category slug ([] for an unknown slug). */
export function skillsForCategory(slug: string | null | undefined): string[] {
  return slug && Object.prototype.hasOwnProperty.call(SKILLS_CATALOG, slug) ? [...SKILLS_CATALOG[slug]] : [];
}

/** The whole catalog flattened and de-duplicated (used only to tell "catalog skill" from "not a skill"). */
export function allCatalogSkills(): string[] {
  return [...new Set(Object.values(SKILLS_CATALOG).flat())];
}

export const normalizeSkillName = clean;
