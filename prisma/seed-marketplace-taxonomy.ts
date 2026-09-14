/**
 * Marketplace Taxonomy Seed (v1)
 *
 * Safely upserts marketplace categories and their nested specialties into the
 * existing `categories` and `specialties` tables. Idempotent: safe to run
 * multiple times because every record is upserted on its unique `slug`.
 *
 * Usage:
 *   npm run seed:taxonomy
 *
 * NOTE: This script does NOT create endpoints, does NOT touch auth/payment/
 * wallet/rating logic, and does NOT print or read any secrets beyond the
 * DATABASE_URL required to connect the Prisma client.
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL must be set before running the taxonomy seed.');
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

interface SpecialtySeed {
  slug: string;
  nameAr: string;
  nameEn: string;
  icon: string;
  description?: string;
  sortOrder: number;
}

interface CategorySeed {
  slug: string;
  nameAr: string;
  nameEn: string;
  icon: string;
  description: string;
  sortOrder: number;
  specialties: SpecialtySeed[];
}

/* -------------------------------------------------------------------------- */
/* Taxonomy data (v1)                                                         */
/* -------------------------------------------------------------------------- */

const TAXONOMY: CategorySeed[] = [
  {
    slug: 'programming-development',
    nameAr: 'برمجة وتطوير',
    nameEn: 'Programming & Development',
    icon: 'code',
    description:
      'خدمات تطوير البرمجيات وتطبيقات الويب والجوال والأنظمة الخلفية باستخدام أحدث التقنيات.',
    sortOrder: 1,
    specialties: [
      { slug: 'web-development-front-end', nameAr: 'تطوير الواجهات الأمامية', nameEn: 'Front-End Development', icon: 'layout', sortOrder: 1, description: 'بناء واجهات المستخدم باستخدام React وVue وAngular.' },
      { slug: 'web-development-back-end', nameAr: 'تطوير الواجهات الخلفية', nameEn: 'Back-End Development', icon: 'server', sortOrder: 2, description: 'بناء واجهات برمجية وخوادم باستخدام Node.js وPython وGo.' },
      { slug: 'full-stack-development', nameAr: 'تطوير متكامل (Full-Stack)', nameEn: 'Full-Stack Development', icon: 'layers', sortOrder: 3, description: 'تطوير الواجهات الأمامية والخلفية معاً.' },
      { slug: 'mobile-development-ios', nameAr: 'تطوير تطبيقات iOS', nameEn: 'iOS Development', icon: 'smartphone', sortOrder: 4, description: 'تطوير تطبيقات iPhone وiPad باستخدام Swift وSwiftUI.' },
      { slug: 'mobile-development-android', nameAr: 'تطوير تطبيقات أندرويد', nameEn: 'Android Development', icon: 'smartphone', sortOrder: 5, description: 'تطوير تطبيقات أندرويد باستخدام Kotlin وJetpack.' },
      { slug: 'cross-platform-mobile', nameAr: 'تطبيقات متعددة المنصات', nameEn: 'Cross-Platform Mobile', icon: 'smartphone', sortOrder: 6, description: 'تطبيقات تعمل على iOS وأندرويد باستخدام Flutter وReact Native.' },
      { slug: 'desktop-development', nameAr: 'تطوير تطبيقات سطح المكتب', nameEn: 'Desktop Development', icon: 'monitor', sortOrder: 7, description: 'تطبيقات Windows وmacOS وLinux باستخدام Electron وTauri.' },
      { slug: 'api-development-integration', nameAr: 'تطوير ودمج واجهات API', nameEn: 'API Development & Integration', icon: 'plug', sortOrder: 8, description: 'تصميم وبناء ودمج واجهات REST وGraphQL.' },
      { slug: 'wordpress-development', nameAr: 'تطوير ووردبريس', nameEn: 'WordPress Development', icon: 'globe', sortOrder: 9, description: 'تطوير قوالب وإضافات ووردبريس.' },
      { slug: 'shopify-development', nameAr: 'تطوير شوبيفاي', nameEn: 'Shopify Development', icon: 'shopping-cart', sortOrder: 10, description: 'تطوير متاجر شوبيفاي وتخصيصها.' },
      { slug: 'php-development', nameAr: 'تطوير PHP', nameEn: 'PHP Development', icon: 'code', sortOrder: 11, description: 'تطوير تطبيقات PHP وLaravel.' },
      { slug: 'python-development', nameAr: 'تطوير Python', nameEn: 'Python Development', icon: 'code', sortOrder: 12, description: 'تطوير تطبيقات وسكربتات Python.' },
      { slug: 'javascript-typescript', nameAr: 'جافاسكريبت وتايبسكريبت', nameEn: 'JavaScript & TypeScript', icon: 'code', sortOrder: 13, description: 'تطوير حلول JavaScript وTypeScript الحديثة.' },
      { slug: 'ruby-development', nameAr: 'تطوير Ruby', nameEn: 'Ruby Development', icon: 'gem', sortOrder: 14, description: 'تطوير تطبيقات Ruby on Rails.' },
      { slug: 'golang-development', nameAr: 'تطوير Go', nameEn: 'Go Development', icon: 'code', sortOrder: 15, description: 'بناء خدمات عالية الأداء باستخدام Go.' },
      { slug: 'java-development', nameAr: 'تطوير Java', nameEn: 'Java Development', icon: 'coffee', sortOrder: 16, description: 'تطوير تطبيقات Java وSpring.' },
      { slug: 'csharp-dotnet', nameAr: 'تطوير C# و.NET', nameEn: 'C# & .NET Development', icon: 'code', sortOrder: 17, description: 'تطوير تطبيقات .NET وC#.' },
      { slug: 'code-review-refactoring', nameAr: 'مراجعة وإعادة هيكلة الكود', nameEn: 'Code Review & Refactoring', icon: 'check-circle', sortOrder: 18, description: 'مراجعة جودة الكود وتحسين بنيته.' },
      { slug: 'bug-fixing-debugging', nameAr: 'إصلاح الأخطاء وتتبعها', nameEn: 'Bug Fixing & Debugging', icon: 'bug', sortOrder: 19, description: 'تشخيص وإصلاح أعطال البرمجيات.' },
      { slug: 'technical-architecture', nameAr: 'البنية التقنية للبرمجيات', nameEn: 'Software Architecture', icon: 'sitemap', sortOrder: 20, description: 'تصميم بنية البرمجيات والأنظمة الموزعة.' },
    ],
  },
  {
    slug: 'ai-data',
    nameAr: 'ذكاء اصطناعي وبيانات',
    nameEn: 'AI & Data',
    icon: 'brain',
    description:
      'خدمات الذكاء الاصطناعي وتعلم الآلة وعلوم البيانات وهندسة البيانات والتحليلات.',
    sortOrder: 2,
    specialties: [
      { slug: 'machine-learning', nameAr: 'تعلم الآلة', nameEn: 'Machine Learning', icon: 'cpu', sortOrder: 1, description: 'بناء وتدريب نماذج تعلم الآلة.' },
      { slug: 'deep-learning', nameAr: 'التعلم العميق', nameEn: 'Deep Learning', icon: 'network', sortOrder: 2, description: 'شبكات عصبية عميقة وحلول رؤية حاسوبية ولغة.' },
      { slug: 'natural-language-processing', nameAr: 'معالجة اللغة الطبيعية', nameEn: 'Natural Language Processing', icon: 'message-square', sortOrder: 3, description: 'نماذج NLP وفهم وتوليد اللغة.' },
      { slug: 'computer-vision', nameAr: 'الرؤية الحاسوبية', nameEn: 'Computer Vision', icon: 'eye', sortOrder: 4, description: 'تحليل الصور والفيديو والكشف عن الكائنات.' },
      { slug: 'large-language-models', nameAr: 'النماذج اللغوية الكبيرة (LLMs)', nameEn: 'Large Language Models', icon: 'brain', sortOrder: 5, description: 'تخصيص ونشر نماذج GPT وLLaMA وغيرها.' },
      { slug: 'generative-ai', nameAr: 'الذكاء الاصطناعي التوليدي', nameEn: 'Generative AI', icon: 'sparkles', sortOrder: 6, description: 'حلول توليد النصوص والصور والصوت.' },
      { slug: 'ai-chatbots-assistants', nameAr: 'روبوتات ومساعدو الذكاء الاصطناعي', nameEn: 'AI Chatbots & Assistants', icon: 'bot', sortOrder: 7, description: 'بناء روبوتات محادثة ذكية.' },
      { slug: 'prompt-engineering', nameAr: 'هندسة الأوامر (Prompt Engineering)', nameEn: 'Prompt Engineering', icon: 'terminal', sortOrder: 8, description: 'تصميم وتحسين أوامر النماذج اللغوية.' },
      { slug: 'data-science', nameAr: 'علوم البيانات', nameEn: 'Data Science', icon: 'bar-chart', sortOrder: 9, description: 'تحليل البيانات واستخلاص الرؤى.' },
      { slug: 'data-engineering', nameAr: 'هندسة البيانات', nameEn: 'Data Engineering', icon: 'database', sortOrder: 10, description: 'بناء خطوط معالجة وتخزين البيانات.' },
      { slug: 'data-analytics', nameAr: 'تحليلات البيانات', nameEn: 'Data Analytics', icon: 'trending-up', sortOrder: 11, description: 'تحليل البيانات وبناء لوحات المعلومات.' },
      { slug: 'big-data', nameAr: 'البيانات الضخمة', nameEn: 'Big Data', icon: 'database', sortOrder: 12, description: 'معالجة البيانات الضخمة باستخدام Spark وHadoop.' },
      { slug: 'data-visualization', nameAr: 'تصور البيانات', nameEn: 'Data Visualization', icon: 'pie-chart', sortOrder: 13, description: 'تصميم لوحات ورسوم بيانية تفاعلية.' },
      { slug: 'etl-pipelines', nameAr: 'خطوط ETL', nameEn: 'ETL Pipelines', icon: 'git-branch', sortOrder: 14, description: 'بناء خطوط استخراج وتحويل وتحميل البيانات.' },
      { slug: 'data-warehousing', nameAr: 'مستودعات البيانات', nameEn: 'Data Warehousing', icon: 'warehouse', sortOrder: 15, description: 'تصميم وبناء مستودعات البيانات.' },
      { slug: 'recommendation-systems', nameAr: 'أنظمة التوصية', nameEn: 'Recommendation Systems', icon: 'star', sortOrder: 16, description: 'بناء محركات التوصية الشخصية.' },
      { slug: 'ai-model-deployment', nameAr: 'نشر نماذج الذكاء الاصطناعي', nameEn: 'AI Model Deployment', icon: 'rocket', sortOrder: 17, description: 'نشر وإدارة نماذج الإنتاج.' },
      { slug: 'ai-consulting', nameAr: 'استشارات الذكاء الاصطناعي', nameEn: 'AI Consulting', icon: 'lightbulb', sortOrder: 18, description: 'استراتيجية تبني الذكاء الاصطناعي.' },
    ],
  },
  {
    slug: 'design-creative',
    nameAr: 'تصميم وإبداع',
    nameEn: 'Design & Creative',
    icon: 'palette',
    description:
      'خدمات التصميم البصري والإبداعي بما في ذلك الواجهات والهوية البصرية والرسومات.',
    sortOrder: 3,
    specialties: [
      { slug: 'ui-ux-design', nameAr: 'تصميم واجهات وتجربة المستخدم', nameEn: 'UI/UX Design', icon: 'layout', sortOrder: 1, description: 'تصميم تجارب وواجهات مستخدم احترافية.' },
      { slug: 'web-design', nameAr: 'تصميم المواقع', nameEn: 'Web Design', icon: 'globe', sortOrder: 2, description: 'تصميم صفحات ومواقع ويب جذابة.' },
      { slug: 'mobile-app-design', nameAr: 'تصميم تطبيقات الجوال', nameEn: 'Mobile App Design', icon: 'smartphone', sortOrder: 3, description: 'تصميم واجهات تطبيقات iOS وأندرويد.' },
      { slug: 'logo-brand-identity', nameAr: 'شعارات وهوية بصرية', nameEn: 'Logo & Brand Identity', icon: 'feather', sortOrder: 4, description: 'تصميم الشعارات ودليل الهوية البصرية.' },
      { slug: 'brand-guidelines', nameAr: 'أدلة العلامة التجارية', nameEn: 'Brand Guidelines', icon: 'book', sortOrder: 5, description: 'إعداد أدلة استخدام العلامة التجارية.' },
      { slug: 'graphic-design', nameAr: 'تصميم جرافيك', nameEn: 'Graphic Design', icon: 'image', sortOrder: 6, description: 'تصاميم مطبوعات ومواد تسويقية.' },
      { slug: 'illustration', nameAr: 'الرسم التوضيحي', nameEn: 'Illustration', icon: 'pen-tool', sortOrder: 7, description: 'رسوم توضيحية مخصصة ورقمية.' },
      { slug: 'icon-design', nameAr: 'تصميم الأيقونات', nameEn: 'Icon Design', icon: 'grid', sortOrder: 8, description: 'تصميم مجموعات أيقونات متسقة.' },
      { slug: 'typography', nameAr: 'الخطوط والطباعة', nameEn: 'Typography', icon: 'type', sortOrder: 9, description: 'تصميم الخطوط والتنسيب الطباعي.' },
      { slug: 'print-design', nameAr: 'تصميم المطبوعات', nameEn: 'Print Design', icon: 'printer', sortOrder: 10, description: 'تصاميم للطباعة: بطاقات وكتيبات.' },
      { slug: 'packaging-design', nameAr: 'تصميم التغليف', nameEn: 'Packaging Design', icon: 'package', sortOrder: 11, description: 'تصميم علب وتغليف المنتجات.' },
      { slug: 'social-media-design', nameAr: 'تصميم سوشيال ميديا', nameEn: 'Social Media Design', icon: 'share-2', sortOrder: 12, description: 'تصاميم منشورات وقوالب سوشيال ميديا.' },
      { slug: 'presentation-design', nameAr: 'تصميم العروض التقديمية', nameEn: 'Presentation Design', icon: 'monitor', sortOrder: 13, description: 'تصميم عروض PowerPoint وKeynote.' },
      { slug: 'infographic-design', nameAr: 'تصميم الإنفوجرافيك', nameEn: 'Infographic Design', icon: 'bar-chart', sortOrder: 14, description: 'تصميم رسوم معلوماتية واضحة.' },
      { slug: '3d-modeling-design', nameAr: 'نمذجة وتصميم ثلاثي الأبعاد', nameEn: '3D Modeling & Design', icon: 'box', sortOrder: 15, description: 'نماذج ورسوم ثلاثية الأبعاد.' },
      { slug: 'character-design', nameAr: 'تصميم الشخصيات', nameEn: 'Character Design', icon: 'user', sortOrder: 16, description: 'تصميم شخصيات للألعاب والرسوم.' },
      { slug: 'design-systems', nameAr: 'أنظمة التصميم', nameEn: 'Design Systems', icon: 'layers', sortOrder: 17, description: 'بناء أنظمة تصميم قابلة لإعادة الاستخدام.' },
      { slug: 'wireframing-prototyping', nameAr: 'المخططات الأولية والنماذج', nameEn: 'Wireframing & Prototyping', icon: 'pen-tool', sortOrder: 18, description: 'مخططات ونماذج تفاعلية أولية.' },
    ],
  },
  {
    slug: 'digital-marketing',
    nameAr: 'تسويق رقمي',
    nameEn: 'Digital Marketing',
    icon: 'megaphone',
    description:
      'خدمات التسويق الرقمي وإدارة الحملات الإعلانية ووسائل التواصل الاجتماعي وتحسين محركات البحث.',
    sortOrder: 4,
    specialties: [
      { slug: 'seo-search-engine-optimization', nameAr: 'تحسين محركات البحث (SEO)', nameEn: 'Search Engine Optimization', icon: 'search', sortOrder: 1, description: 'تحسين ظهور المواقع في نتائج البحث.' },
      { slug: 'sem-ppc-advertising', nameAr: 'إعلانات SEM وPPC', nameEn: 'SEM & PPC Advertising', icon: 'mouse-pointer', sortOrder: 2, description: 'إدارة حملات Google Ads وBing.' },
      { slug: 'social-media-marketing', nameAr: 'تسويق وسائل التواصل', nameEn: 'Social Media Marketing', icon: 'share-2', sortOrder: 3, description: 'إدارة وتنمية حسابات التواصل الاجتماعي.' },
      { slug: 'content-marketing', nameAr: 'تسويق المحتوى', nameEn: 'Content Marketing', icon: 'file-text', sortOrder: 4, description: 'استراتيجيات محتوى لجذب العملاء.' },
      { slug: 'email-marketing', nameAr: 'تسويق عبر البريد الإلكتروني', nameEn: 'Email Marketing', icon: 'mail', sortOrder: 5, description: 'حملات بريدية وأتمتة التسويق.' },
      { slug: 'influencer-marketing', nameAr: 'التسويق عبر المؤثرين', nameEn: 'Influencer Marketing', icon: 'star', sortOrder: 6, description: 'إدارة حملات المؤثرين.' },
      { slug: 'affiliate-marketing', nameAr: 'التسويق بالعمولة', nameEn: 'Affiliate Marketing', icon: 'link', sortOrder: 7, description: 'بناء وإدارة برامج العمولة.' },
      { slug: 'marketing-strategy', nameAr: 'استراتيجية التسويق', nameEn: 'Marketing Strategy', icon: 'map', sortOrder: 8, description: 'وضع خطط تسويقية متكاملة.' },
      { slug: 'growth-hacking', nameAr: 'النمو السريع (Growth Hacking)', nameEn: 'Growth Hacking', icon: 'trending-up', sortOrder: 9, description: 'تجارب نمو سريعة ومبتكرة.' },
      { slug: 'conversion-rate-optimization', nameAr: 'تحسين معدل التحويل (CRO)', nameEn: 'Conversion Rate Optimization', icon: 'percent', sortOrder: 10, description: 'تحسين صفحات الهبوط وزيادة التحويلات.' },
      { slug: 'marketing-analytics', nameAr: 'تحليلات التسويق', nameEn: 'Marketing Analytics', icon: 'bar-chart', sortOrder: 11, description: 'قياس وتحليل أداء الحملات.' },
      { slug: 'paid-social-ads', nameAr: 'إعلانات السوشيال المدفوعة', nameEn: 'Paid Social Ads', icon: 'share-2', sortOrder: 12, description: 'حملات Meta وTikTok وLinkedIn.' },
      { slug: 'community-management', nameAr: 'إدارة المجتمعات', nameEn: 'Community Management', icon: 'users', sortOrder: 13, description: 'إدارة تفاعل المجتمعات الرقمية.' },
      { slug: 'brand-marketing', nameAr: 'تسويق العلامة التجارية', nameEn: 'Brand Marketing', icon: 'feather', sortOrder: 14, description: 'بناء حضور العلامة التجارية رقمياً.' },
      { slug: 'local-seo', nameAr: 'تحسين البحث المحلي', nameEn: 'Local SEO', icon: 'map-pin', sortOrder: 15, description: 'تحسين الظهور المحلي وGoogle Business.' },
      { slug: 'marketing-automation', nameAr: 'أتمتة التسويق', nameEn: 'Marketing Automation', icon: 'zap', sortOrder: 16, description: 'أتمتة رحلة العميل والتسويق.' },
    ],
  },
  {
    slug: 'writing-translation',
    nameAr: 'كتابة وترجمة',
    nameEn: 'Writing & Translation',
    icon: 'pen-tool',
    description:
      'خدمات الكتابة والتحرير والترجمة وتدقيق المحتوى بمختلف اللغات.',
    sortOrder: 5,
    specialties: [
      { slug: 'copywriting', nameAr: 'كتابة الإعلانات (Copywriting)', nameEn: 'Copywriting', icon: 'pen-tool', sortOrder: 1, description: 'كتابة نصوص تسويقية مقنعة.' },
      { slug: 'content-writing', nameAr: 'كتابة المحتوى', nameEn: 'Content Writing', icon: 'file-text', sortOrder: 2, description: 'كتابة مقالات ومحتوى للمواقع.' },
      { slug: 'blog-writing', nameAr: 'كتابة المدونات', nameEn: 'Blog Writing', icon: 'file', sortOrder: 3, description: 'كتابة منشورات مدونة متخصصة.' },
      { slug: 'technical-writing', nameAr: 'الكتابة التقنية', nameEn: 'Technical Writing', icon: 'book', sortOrder: 4, description: 'كتابة أدلة ووثائق تقنية.' },
      { slug: 'creative-writing', nameAr: 'الكتابة الإبداعية', nameEn: 'Creative Writing', icon: 'feather', sortOrder: 5, description: 'كتابة قصصية وإبداعية.' },
      { slug: 'editing-proofreading', nameAr: 'التحرير والتدقيق اللغوي', nameEn: 'Editing & Proofreading', icon: 'check', sortOrder: 6, description: 'تدقيق وتحرير النصوص لغوياً.' },
      { slug: 'translation', nameAr: 'الترجمة', nameEn: 'Translation', icon: 'languages', sortOrder: 7, description: 'ترجمة نصية بين اللغات.' },
      { slug: 'localization', nameAr: 'التوطين (Localization)', nameEn: 'Localization', icon: 'globe', sortOrder: 8, description: 'توطين التطبيقات والمواقع للأسواق المحلية.' },
      { slug: 'transcription', nameAr: 'التفريغ الصوتي', nameEn: 'Transcription', icon: 'mic', sortOrder: 9, description: 'تفريغ الصوت والفيديو إلى نص.' },
      { slug: 'subtitling-captioning', nameAr: 'الترجمة النصية للفيديو', nameEn: 'Subtitling & Captioning', icon: 'film', sortOrder: 10, description: 'إضافة ترجمة نصية للفيديوهات.' },
      { slug: 'grant-writing', nameAr: 'كتابة المنح والمقترحات', nameEn: 'Grant & Proposal Writing', icon: 'file-text', sortOrder: 11, description: 'كتابة مقترحات ومنح تمويلية.' },
      { slug: 'resume-writing', nameAr: 'كتابة السير الذاتية', nameEn: 'Resume Writing', icon: 'briefcase', sortOrder: 12, description: 'إعداد وتحسين السير الذاتية.' },
      { slug: 'press-release-writing', nameAr: 'كتابة البيانات الصحفية', nameEn: 'Press Release Writing', icon: 'newspaper', sortOrder: 13, description: 'صياغة بيانات صحفية احترافية.' },
      { slug: 'scriptwriting', nameAr: 'كتابة السكربتات', nameEn: 'Scriptwriting', icon: 'film', sortOrder: 14, description: 'كتابة سكربتات الفيديو والبودكاست.' },
      { slug: 'ghostwriting', nameAr: 'الكتابة بالنيابة', nameEn: 'Ghostwriting', icon: 'feather', sortOrder: 15, description: 'كتابة محتوى باسم العميل.' },
      { slug: 'arabic-translation', nameAr: 'الترجمة العربية', nameEn: 'Arabic Translation', icon: 'languages', sortOrder: 16, description: 'ترجمة من وإلى اللغة العربية.' },
      { slug: 'english-translation', nameAr: 'الترجمة الإنجليزية', nameEn: 'English Translation', icon: 'languages', sortOrder: 17, description: 'ترجمة من وإلى اللغة الإنجليزية.' },
    ],
  },
  {
    slug: 'business-consulting',
    nameAr: 'أعمال واستشارات',
    nameEn: 'Business & Consulting',
    icon: 'briefcase',
    description:
      'خدمات استشارية لإدارة الأعمال والاستراتيجية والتخطيط والعمليات.',
    sortOrder: 6,
    specialties: [
      { slug: 'business-strategy', nameAr: 'استراتيجية الأعمال', nameEn: 'Business Strategy', icon: 'map', sortOrder: 1, description: 'وضع وتنفيذ استراتيجيات الأعمال.' },
      { slug: 'management-consulting', nameAr: 'استشارات الإدارة', nameEn: 'Management Consulting', icon: 'briefcase', sortOrder: 2, description: 'تحسين أداء وكفاءة المنظمات.' },
      { slug: 'business-plans', nameAr: 'خطط العمل', nameEn: 'Business Plans', icon: 'file-text', sortOrder: 3, description: 'إعداد خطط عمل شاملة.' },
      { slug: 'market-research', nameAr: 'أبحاث السوق', nameEn: 'Market Research', icon: 'search', sortOrder: 4, description: 'دراسات جدوى وأبحاث السوق.' },
      { slug: 'operations-consulting', nameAr: 'استشارات العمليات', nameEn: 'Operations Consulting', icon: 'settings', sortOrder: 5, description: 'تحسين عمليات وسلاسل الإمداد.' },
      { slug: 'project-management', nameAr: 'إدارة المشاريع', nameEn: 'Project Management', icon: 'clipboard', sortOrder: 6, description: 'إدارة وتنفيذ المشاريع باحترافية.' },
      { slug: 'agile-coaching', nameAr: 'تدريب أجايل', nameEn: 'Agile Coaching', icon: 'refresh-cw', sortOrder: 7, description: 'تطبيق منهجيات Agile وScrum.' },
      { slug: 'change-management', nameAr: 'إدارة التغيير', nameEn: 'Change Management', icon: 'git-branch', sortOrder: 8, description: 'إدارة التحول التنظيمي.' },
      { slug: 'hr-consulting', nameAr: 'استشارات الموارد البشرية', nameEn: 'HR Consulting', icon: 'users', sortOrder: 9, description: 'سياسات وهيكلة الموارد البشرية.' },
      { slug: 'recruitment-talent', nameAr: 'التوظيف واكتساب المواهب', nameEn: 'Recruitment & Talent', icon: 'user-plus', sortOrder: 10, description: 'استقطاب وتوظيف المواهب.' },
      { slug: 'organizational-design', nameAr: 'التصميم التنظيمي', nameEn: 'Organizational Design', icon: 'sitemap', sortOrder: 11, description: 'هيكلة وتصميم المنظمات.' },
      { slug: 'process-improvement', nameAr: 'تحسين العمليات', nameEn: 'Process Improvement', icon: 'trending-up', sortOrder: 12, description: 'إعادة هندسة وتحسين العمليات.' },
      { slug: 'risk-management', nameAr: 'إدارة المخاطر', nameEn: 'Risk Management', icon: 'shield', sortOrder: 13, description: 'تقييم وإدارة مخاطر الأعمال.' },
      { slug: 'startup-consulting', nameAr: 'استشارات الشركات الناشئة', nameEn: 'Startup Consulting', icon: 'rocket', sortOrder: 14, description: 'دعم تأسيس ونمو الشركات الناشئة.' },
      { slug: 'business-analysis', nameAr: 'تحليل الأعمال', nameEn: 'Business Analysis', icon: 'bar-chart', sortOrder: 15, description: 'تحليل متطلبات وحلول الأعمال.' },
      { slug: 'fractional-executives', nameAr: 'تنفيذيون بدوام جزئي', nameEn: 'Fractional Executives', icon: 'user', sortOrder: 16, description: 'خدمات تنفيذية بدوام جزئي.' },
    ],
  },
  {
    slug: 'finance-accounting',
    nameAr: 'مالية ومحاسبة',
    nameEn: 'Finance & Accounting',
    icon: 'dollar-sign',
    description:
      'خدمات مالية ومحاسبية وضريبية ومراجعة وتخطيط مالي للأفراد والشركات.',
    sortOrder: 7,
    specialties: [
      { slug: 'bookkeeping', nameAr: 'مسك الدفاتر', nameEn: 'Bookkeeping', icon: 'book', sortOrder: 1, description: 'تسجيل وتبويب المعاملات المالية.' },
      { slug: 'financial-accounting', nameAr: 'المحاسبة المالية', nameEn: 'Financial Accounting', icon: 'calculator', sortOrder: 2, description: 'إعداد القوائم والحسابات المالية.' },
      { slug: 'financial-planning', nameAr: 'التخطيط المالي', nameEn: 'Financial Planning', icon: 'trending-up', sortOrder: 3, description: 'خطط مالية شخصية ومؤسسية.' },
      { slug: 'tax-consulting', nameAr: 'استشارات ضريبية', nameEn: 'Tax Consulting', icon: 'percent', sortOrder: 4, description: 'إعداد وتقديم الإقرارات الضريبية.' },
      { slug: 'tax-preparation', nameAr: 'إعداد الضرائب', nameEn: 'Tax Preparation', icon: 'file-text', sortOrder: 5, description: 'تجهيز وتقديم الملفات الضريبية.' },
      { slug: 'auditing', nameAr: 'المراجعة والتدقيق', nameEn: 'Auditing', icon: 'check-circle', sortOrder: 6, description: 'مراجعة وتدقيق الحسابات.' },
      { slug: 'payroll-services', nameAr: 'خدمات الرواتب', nameEn: 'Payroll Services', icon: 'users', sortOrder: 7, description: 'إدارة ومعالجة الرواتب.' },
      { slug: 'financial-modeling', nameAr: 'النمذجة المالية', nameEn: 'Financial Modeling', icon: 'bar-chart', sortOrder: 8, description: 'بناء نماذج مالية وتوقعات.' },
      { slug: 'budgeting-forecasting', nameAr: 'الميزانيات والتوقعات', nameEn: 'Budgeting & Forecasting', icon: 'calendar', sortOrder: 9, description: 'إعداد الميزانيات والتوقعات المالية.' },
      { slug: 'investment-advisory', nameAr: 'استشارات الاستثمار', nameEn: 'Investment Advisory', icon: 'trending-up', sortOrder: 10, description: 'استشارات في الاستثمار والمحافظ.' },
      { slug: 'corporate-finance', nameAr: 'تمويل الشركات', nameEn: 'Corporate Finance', icon: 'briefcase', sortOrder: 11, description: 'هيكلة وتمويل الشركات.' },
      { slug: 'accounts-payable-receivable', nameAr: 'الذمم الدائنة والمدينة', nameEn: 'Accounts Payable & Receivable', icon: 'file', sortOrder: 12, description: 'إدارة الذمم الدائنة والمدينة.' },
      { slug: 'financial-reporting', nameAr: 'التقارير المالية', nameEn: 'Financial Reporting', icon: 'file-text', sortOrder: 13, description: 'إعداد التقارير المالية الدورية.' },
      { slug: 'cost-accounting', nameAr: 'محاسبة التكاليف', nameEn: 'Cost Accounting', icon: 'calculator', sortOrder: 14, description: 'تحليل وإدارة التكاليف.' },
      { slug: 'treasury-management', nameAr: 'إدارة الخزانة', nameEn: 'Treasury Management', icon: 'dollar-sign', sortOrder: 15, description: 'إدارة السيولة والخزانة.' },
      { slug: 'virtual-cfo', nameAr: 'مدير مالي افتراضي (CFO)', nameEn: 'Virtual CFO', icon: 'user', sortOrder: 16, description: 'خدمات مدير مالي بدوام جزئي.' },
    ],
  },
  {
    slug: 'engineering-architecture',
    nameAr: 'هندسة وعمارة',
    nameEn: 'Engineering & Architecture',
    icon: 'compass',
    description:
      'خدمات هندسية ومعمارية وتصميم إنشائي وكهربائي وميكانيكي.',
    sortOrder: 8,
    specialties: [
      { slug: 'architectural-design', nameAr: 'التصميم المعماري', nameEn: 'Architectural Design', icon: 'compass', sortOrder: 1, description: 'تصميم مبانٍ ومساحات معمارية.' },
      { slug: 'structural-engineering', nameAr: 'الهندسة الإنشائية', nameEn: 'Structural Engineering', icon: 'building', sortOrder: 2, description: 'تصميم وحساب الإنشاءات.' },
      { slug: 'civil-engineering', nameAr: 'الهندسة المدنية', nameEn: 'Civil Engineering', icon: 'hard-hat', sortOrder: 3, description: 'تصميم وإدارة المشاريع المدنية.' },
      { slug: 'electrical-engineering', nameAr: 'الهندسة الكهربائية', nameEn: 'Electrical Engineering', icon: 'zap', sortOrder: 4, description: 'تصميم الأنظمة الكهربائية.' },
      { slug: 'mechanical-engineering', nameAr: 'الهندسة الميكانيكية', nameEn: 'Mechanical Engineering', icon: 'settings', sortOrder: 5, description: 'تصميم الأنظمة الميكانيكية.' },
      { slug: 'hvac-engineering', nameAr: 'هندسة التكييف والتهوية', nameEn: 'HVAC Engineering', icon: 'wind', sortOrder: 6, description: 'تصميم أنظمة التكييف والتهوية.' },
      { slug: 'plumbing-engineering', nameAr: 'هندسة الصحي والسباكة', nameEn: 'Plumbing Engineering', icon: 'droplet', sortOrder: 7, description: 'تصميم أنظمة الصحي والسباكة.' },
      { slug: 'interior-architecture', nameAr: 'العمارة الداخلية', nameEn: 'Interior Architecture', icon: 'home', sortOrder: 8, description: 'تصميم المساحات الداخلية.' },
      { slug: 'landscape-architecture', nameAr: 'هندسة تنسيق الحدائق', nameEn: 'Landscape Architecture', icon: 'tree', sortOrder: 9, description: 'تصميم المساحات الخارجية والحدائق.' },
      { slug: 'urban-planning', nameAr: 'التخطيط الحضري', nameEn: 'Urban Planning', icon: 'map', sortOrder: 10, description: 'تخطيط المدن والمناطق الحضرية.' },
      { slug: 'cad-drafting', nameAr: 'الرسم الهندسي (CAD)', nameEn: 'CAD Drafting', icon: 'pen-tool', sortOrder: 11, description: 'رسومات هندسية ثنائية وثلاثية الأبعاد.' },
      { slug: 'bim-modeling', nameAr: 'نمذجة معلومات البناء (BIM)', nameEn: 'BIM Modeling', icon: 'box', sortOrder: 12, description: 'نماذج BIM للمشاريع الإنشائية.' },
      { slug: 'quantity-surveying', nameAr: 'قياس الكميات', nameEn: 'Quantity Surveying', icon: 'calculator', sortOrder: 13, description: 'تقدير كميات وتكاليف البناء.' },
      { slug: 'construction-management', nameAr: 'إدارة الإنشاءات', nameEn: 'Construction Management', icon: 'hard-hat', sortOrder: 14, description: 'إدارة مواقع ومشاريع البناء.' },
      { slug: 'sustainable-green-design', nameAr: 'التصميم المستدام والأخضر', nameEn: 'Sustainable & Green Design', icon: 'leaf', sortOrder: 15, description: 'حلول معمارية صديقة للبيئة.' },
      { slug: '3d-rendering-architecture', nameAr: 'تجسيم ثلاثي الأبعاد للعمارة', nameEn: '3D Architectural Rendering', icon: 'box', sortOrder: 16, description: 'تجسيمات معمارية واقعية.' },
    ],
  },
  {
    slug: 'video-audio',
    nameAr: 'فيديو وصوت',
    nameEn: 'Video & Audio',
    icon: 'video',
    description:
      'خدمات إنتاج وتحرير الفيديو والصوت والموسيقى والتعليق الصوتي.',
    sortOrder: 9,
    specialties: [
      { slug: 'video-editing', nameAr: 'تحرير الفيديو', nameEn: 'Video Editing', icon: 'film', sortOrder: 1, description: 'مونتاج وتحرير الفيديو.' },
      { slug: 'video-production', nameAr: 'إنتاج الفيديو', nameEn: 'Video Production', icon: 'video', sortOrder: 2, description: 'تصوير وإنتاج فيديوهات احترافية.' },
      { slug: 'motion-graphics', nameAr: 'الموشن جرافيك', nameEn: 'Motion Graphics', icon: 'zap', sortOrder: 3, description: 'رسوم متحركة وموشن جرافيك.' },
      { slug: 'animation-2d-3d', nameAr: 'أنيميشن ثنائي وثلاثي الأبعاد', nameEn: '2D & 3D Animation', icon: 'film', sortOrder: 4, description: 'إنتاج رسوم متحركة.' },
      { slug: 'voice-over', nameAr: 'التعليق الصوتي', nameEn: 'Voice Over', icon: 'mic', sortOrder: 5, description: 'تسجيل تعليق صوتي احترافي.' },
      { slug: 'audio-editing', nameAr: 'تحرير الصوت', nameEn: 'Audio Editing', icon: 'sliders', sortOrder: 6, description: 'مونتاج وتنقية الصوت.' },
      { slug: 'music-production', nameAr: 'إنتاج الموسيقى', nameEn: 'Music Production', icon: 'music', sortOrder: 7, description: 'تأليف وإنتاج موسيقى.' },
      { slug: 'sound-design', nameAr: 'تصميم الصوت', nameEn: 'Sound Design', icon: 'volume-2', sortOrder: 8, description: 'تصميم مؤثرات صوتية.' },
      { slug: 'podcast-production', nameAr: 'إنتاج البودكاست', nameEn: 'Podcast Production', icon: 'mic', sortOrder: 9, description: 'إنتاج وتحرير حلقات البودكاست.' },
      { slug: 'mixing-mastering', nameAr: 'المكساج والماسترينغ', nameEn: 'Mixing & Mastering', icon: 'sliders', sortOrder: 10, description: 'مزج ومعالجة الصوت نهائياً.' },
      { slug: 'youtube-video-editing', nameAr: 'تحرير فيديو يوتيوب', nameEn: 'YouTube Video Editing', icon: 'youtube', sortOrder: 11, description: 'مونتاج فيديوهات يوتيوب جذابة.' },
      { slug: 'short-form-video', nameAr: 'فيديو قصير (Reels/TikTok)', nameEn: 'Short-Form Video', icon: 'smartphone', sortOrder: 12, description: 'إنتاج فيديوهات قصيرة للسوشيال.' },
      { slug: 'color-grading', nameAr: 'تدرج الألوان (Color Grading)', nameEn: 'Color Grading', icon: 'droplet', sortOrder: 13, description: 'معالجة وتدرج ألوان الفيديو.' },
      { slug: 'jingles-audio-ads', nameAr: 'الإعلانات والجنغل الصوتية', nameEn: 'Jingles & Audio Ads', icon: 'music', sortOrder: 14, description: 'تأليف إعلانات صوتية وجنغل.' },
      { slug: 'live-stream-production', nameAr: 'إنتاج البث المباشر', nameEn: 'Live Stream Production', icon: 'radio', sortOrder: 15, description: 'إدارة وإنتاج البث المباشر.' },
      { slug: 'audio-transcription-services', nameAr: 'تفريغ صوتي للوسائط', nameEn: 'Media Audio Transcription', icon: 'file-text', sortOrder: 16, description: 'تفريغ المحتوى الصوتي إلى نصوص.' },
    ],
  },
  {
    slug: 'education-training',
    nameAr: 'تعليم وتدريب',
    nameEn: 'Education & Training',
    icon: 'book-open',
    description:
      'خدمات التعليم والتدريب والتطوير المهني عن بعد وفي مختلف المجالات.',
    sortOrder: 10,
    specialties: [
      { slug: 'online-tutoring', nameAr: 'الدراسة عبر الإنترنت', nameEn: 'Online Tutoring', icon: 'book-open', sortOrder: 1, description: 'تدريس خصوصي عبر الإنترنت.' },
      { slug: 'language-teaching', nameAr: 'تعليم اللغات', nameEn: 'Language Teaching', icon: 'languages', sortOrder: 2, description: 'تدريس اللغات للأفراد والمجموعات.' },
      { slug: 'curriculum-development', nameAr: 'تطوير المناهج', nameEn: 'Curriculum Development', icon: 'book', sortOrder: 3, description: 'تصميم وإعداد المناهج التعليمية.' },
      { slug: 'e-learning-course-creation', nameAr: 'إنشاء دورات إلكترونية', nameEn: 'E-Learning Course Creation', icon: 'monitor', sortOrder: 4, description: 'بناء دورات تعليمية رقمية.' },
      { slug: 'corporate-training', nameAr: 'التدريب المؤسسي', nameEn: 'Corporate Training', icon: 'briefcase', sortOrder: 5, description: 'برامج تدريب للموظفين.' },
      { slug: 'professional-coaching', nameAr: 'التدريب المهني', nameEn: 'Professional Coaching', icon: 'user', sortOrder: 6, description: 'تطوير المهارات المهنية.' },
      { slug: 'test-prep-tutoring', nameAr: 'التحضير للاختبارات', nameEn: 'Test Prep Tutoring', icon: 'clipboard', sortOrder: 7, description: 'تحضير لاختبارات IELTS وTOEFL وغيرها.' },
      { slug: 'academic-writing-help', nameAr: 'المساعدة في الكتابة الأكاديمية', nameEn: 'Academic Writing Help', icon: 'pen-tool', sortOrder: 8, description: 'دعم كتابة الأبحاث والأطروحات.' },
      { slug: 'stem-education', nameAr: 'تعليم STEM', nameEn: 'STEM Education', icon: 'flask-conical', sortOrder: 9, description: 'تدريس العلوم والرياضيات والهندسة.' },
      { slug: 'coding-bootcamps', nameAr: 'معسكرات البرمجة', nameEn: 'Coding Bootcamps', icon: 'code', sortOrder: 10, description: 'تدريب مكثف على البرمجة.' },
      { slug: 'kids-education', nameAr: 'تعليم الأطفال', nameEn: 'Kids Education', icon: 'smile', sortOrder: 11, description: 'محتوى وتدريس للأطفال.' },
      { slug: 'instructional-design', nameAr: 'التصميم التعليمي', nameEn: 'Instructional Design', icon: 'layout', sortOrder: 12, description: 'تصميم تجارب تعلم فعّالة.' },
      { slug: 'study-skills-coaching', nameAr: 'تدريب على مهارات الدراسة', nameEn: 'Study Skills Coaching', icon: 'book', sortOrder: 13, description: 'تحسين مهارات وعادات الدراسة.' },
      { slug: 'homework-help', nameAr: 'المساعدة في الواجبات', nameEn: 'Homework Help', icon: 'pencil', sortOrder: 14, description: 'دعم الطلاب في الواجبات المدرسية.' },
      { slug: 'mentoring', nameAr: 'الإرشاد المهني', nameEn: 'Mentoring', icon: 'users', sortOrder: 15, description: 'إرشاد مهني وقيادي.' },
    ],
  },
  {
    slug: 'admin-support',
    nameAr: 'دعم إداري',
    nameEn: 'Admin Support',
    icon: 'clipboard',
    description:
      'خدمات الدعم الإداري والمكتبي والتنظيمي عن بعد.',
    sortOrder: 11,
    specialties: [
      { slug: 'virtual-assistant', nameAr: 'مساعد افتراضي', nameEn: 'Virtual Assistant', icon: 'user', sortOrder: 1, description: 'مساعدة إدارية عن بعد.' },
      { slug: 'data-entry', nameAr: 'إدخال البيانات', nameEn: 'Data Entry', icon: 'keyboard', sortOrder: 2, description: 'إدخال وتنظيم البيانات.' },
      { slug: 'calendar-scheduling', nameAr: 'إدارة المواعيد والتقويم', nameEn: 'Calendar & Scheduling', icon: 'calendar', sortOrder: 3, description: 'تنظيم المواعيد والجداول.' },
      { slug: 'email-management', nameAr: 'إدارة البريد الإلكتروني', nameEn: 'Email Management', icon: 'mail', sortOrder: 4, description: 'تنظيم ومتابعة البريد.' },
      { slug: 'travel-planning', nameAr: 'تخطيط السفر', nameEn: 'Travel Planning', icon: 'plane', sortOrder: 5, description: 'تنظيم رحلات وحجوزات السفر.' },
      { slug: 'appointment-setting', nameAr: 'تحديد المواعيد', nameEn: 'Appointment Setting', icon: 'calendar', sortOrder: 6, description: 'حجز وتأكيد المواعيد.' },
      { slug: 'document-formatting', nameAr: 'تنسيق المستندات', nameEn: 'Document Formatting', icon: 'file-text', sortOrder: 7, description: 'تنسيق وتحرير المستندات.' },
      { slug: 'transcription-admin', nameAr: 'التفريغ النصي', nameEn: 'Transcription', icon: 'mic', sortOrder: 8, description: 'تفريغ الاجتماعات والمقابلات.' },
      { slug: 'research-services', nameAr: 'خدمات البحث', nameEn: 'Research Services', icon: 'search', sortOrder: 9, description: 'أبحاث وجمع معلومات.' },
      { slug: 'lead-generation', nameAr: 'توليد العملاء المحتملين', nameEn: 'Lead Generation', icon: 'users', sortOrder: 10, description: 'البحث عن عملاء محتملين.' },
      { slug: 'crm-management', nameAr: 'إدارة CRM', nameEn: 'CRM Management', icon: 'database', sortOrder: 11, description: 'إدارة قواعد بيانات العملاء.' },
      { slug: 'spreadsheet-management', nameAr: 'إدارة جداول البيانات', nameEn: 'Spreadsheet Management', icon: 'grid', sortOrder: 12, description: 'تنظيم وتحليل جداول البيانات.' },
      { slug: 'file-organization', nameAr: 'تنظيم الملفات', nameEn: 'File Organization', icon: 'folder', sortOrder: 13, description: 'ترتيب وأرشفة الملفات الرقمية.' },
      { slug: 'bookkeeping-admin', nameAr: 'مسك الدفاتر الإداري', nameEn: 'Admin Bookkeeping', icon: 'book', sortOrder: 14, description: 'متابعة المعاملات الإدارية البسيطة.' },
      { slug: 'personal-assistant', nameAr: 'مساعد شخصي', nameEn: 'Personal Assistant', icon: 'user', sortOrder: 15, description: 'خدمات مساعدة شخصية عن بعد.' },
    ],
  },
  {
    slug: 'customer-support',
    nameAr: 'دعم وخدمة عملاء',
    nameEn: 'Customer Support',
    icon: 'headphones',
    description:
      'خدمات دعم العملاء وخدمة العملاء عبر القنوات المختلفة.',
    sortOrder: 12,
    specialties: [
      { slug: 'customer-service-chat', nameAr: 'خدمة العملاء عبر الدردشة', nameEn: 'Chat Customer Service', icon: 'message-square', sortOrder: 1, description: 'دعم العملاء عبر الدردشة المباشرة.' },
      { slug: 'customer-service-phone', nameAr: 'خدمة العملاء عبر الهاتف', nameEn: 'Phone Customer Service', icon: 'phone', sortOrder: 2, description: 'دعم العملاء عبر المكالمات.' },
      { slug: 'email-support', nameAr: 'الدعم عبر البريد الإلكتروني', nameEn: 'Email Support', icon: 'mail', sortOrder: 3, description: 'الرد على استفسارات العملاء بالبريد.' },
      { slug: 'ticketing-support', nameAr: 'دعم التذاكر', nameEn: 'Ticketing Support', icon: 'ticket', sortOrder: 4, description: 'إدارة تذاكر الدعم الفني.' },
      { slug: 'technical-support', nameAr: 'الدعم الفني', nameEn: 'Technical Support', icon: 'wrench', sortOrder: 5, description: 'دعم فني للمنتجات والخدمات.' },
      { slug: 'helpdesk-management', nameAr: 'إدارة مكتب المساعدة', nameEn: 'Helpdesk Management', icon: 'life-buoy', sortOrder: 6, description: 'إدارة فريق مكتب المساعدة.' },
      { slug: 'knowledge-base-creation', nameAr: 'إنشاء قاعدة المعرفة', nameEn: 'Knowledge Base Creation', icon: 'book', sortOrder: 7, description: 'كتابة مقالات قاعدة المعرفة.' },
      { slug: 'community-moderation', nameAr: 'إدارة المجتمعات', nameEn: 'Community Moderation', icon: 'users', sortOrder: 8, description: 'إدارة ومراقبة مجتمعات العملاء.' },
      { slug: 'customer-onboarding', nameAr: 'تأهيل العملاء', nameEn: 'Customer Onboarding', icon: 'user-plus', sortOrder: 9, description: 'توجيه العملاء الجدد.' },
      { slug: 'complaint-handling', nameAr: 'معالجة الشكاوى', nameEn: 'Complaint Handling', icon: 'alert-circle', sortOrder: 10, description: 'إدارة وحل شكاوى العملاء.' },
      { slug: 'multilingual-support', nameAr: 'دعم متعدد اللغات', nameEn: 'Multilingual Support', icon: 'languages', sortOrder: 11, description: 'دعم العملاء بلغات متعددة.' },
      { slug: 'social-media-support', nameAr: 'الدعم عبر السوشيال ميديا', nameEn: 'Social Media Support', icon: 'share-2', sortOrder: 12, description: 'الرد على العملاء عبر السوشيال.' },
      { slug: 'order-management-support', nameAr: 'دعم إدارة الطلبات', nameEn: 'Order Management Support', icon: 'shopping-cart', sortOrder: 13, description: 'متابعة ومعالجة الطلبات.' },
      { slug: 'refund-returns-support', nameAr: 'دعم الاسترداد والإرجاع', nameEn: 'Refund & Returns Support', icon: 'rotate-ccw', sortOrder: 14, description: 'معالجة طلبات الاسترداد والإرجاع.' },
    ],
  },
  {
    slug: 'e-commerce',
    nameAr: 'تجارة إلكترونية',
    nameEn: 'E-commerce',
    icon: 'shopping-cart',
    description:
      'خدمات التجارة الإلكترونية وإدارة المتاجر والمنتجات والوفاء والشحن.',
    sortOrder: 13,
    specialties: [
      { slug: 'store-setup', nameAr: 'إعداد المتاجر', nameEn: 'Store Setup', icon: 'shopping-cart', sortOrder: 1, description: 'إنشاء وإعداد متاجر إلكترونية.' },
      { slug: 'product-listing', nameAr: 'إدراج المنتجات', nameEn: 'Product Listing', icon: 'package', sortOrder: 2, description: 'إضافة وتنظيم المنتجات.' },
      { slug: 'product-description-writing', nameAr: 'كتابة أوصاف المنتجات', nameEn: 'Product Description Writing', icon: 'pen-tool', sortOrder: 3, description: 'صياغة أوصاف بيعية للمنتجات.' },
      { slug: 'inventory-management', nameAr: 'إدارة المخزون', nameEn: 'Inventory Management', icon: 'archive', sortOrder: 4, description: 'متابعة وإدارة المخزون.' },
      { slug: 'order-fulfillment', nameAr: 'تنفيذ الطلبات', nameEn: 'Order Fulfillment', icon: 'truck', sortOrder: 5, description: 'معالجة وشحن الطلبات.' },
      { slug: 'dropshipping-management', nameAr: 'إدارة الدروبشيبينغ', nameEn: 'Dropshipping Management', icon: 'package', sortOrder: 6, description: 'إدارة عمليات الدروبشيبينغ.' },
      { slug: 'marketplace-listing', nameAr: 'إدراج في الأسواق', nameEn: 'Marketplace Listing', icon: 'globe', sortOrder: 7, description: 'إدراج المنتجات في Amazon وeBay.' },
      { slug: 'amazon-fba', nameAr: 'أمازون FBA', nameEn: 'Amazon FBA', icon: 'package', sortOrder: 8, description: 'إدارة عمليات Amazon FBA.' },
      { slug: 'shopify-store-management', nameAr: 'إدارة متاجر شوبيفاي', nameEn: 'Shopify Store Management', icon: 'shopping-cart', sortOrder: 9, description: 'إدارة وتحسين متاجر شوبيفاي.' },
      { slug: 'product-photography', nameAr: 'تصوير المنتجات', nameEn: 'Product Photography', icon: 'camera', sortOrder: 10, description: 'تصوير احترافي للمنتجات.' },
      { slug: 'conversion-optimization-ecom', nameAr: 'تحسين التحويل للمتاجر', nameEn: 'E-commerce Conversion Optimization', icon: 'percent', sortOrder: 11, description: 'تحسين معدلات التحويل في المتاجر.' },
      { slug: 'ecommerce-seo', nameAr: 'تحسين محركات البحث للمتاجر', nameEn: 'E-commerce SEO', icon: 'search', sortOrder: 12, description: 'تحسين ظهور المنتجات في البحث.' },
      { slug: 'marketplace-advertising', nameAr: 'إعلانات الأسواق', nameEn: 'Marketplace Advertising', icon: 'megaphone', sortOrder: 13, description: 'إدارة حملات Amazon Ads وغيرها.' },
      { slug: 'returns-management', nameAr: 'إدارة المرتجعات', nameEn: 'Returns Management', icon: 'rotate-ccw', sortOrder: 14, description: 'معالجة وإدارة المرتجعات.' },
      { slug: 'supplier-sourcing', nameAr: 'البحث عن الموردين', nameEn: 'Supplier Sourcing', icon: 'search', sortOrder: 15, description: 'البحث والتفاوض مع الموردين.' },
      { slug: 'ecommerce-analytics', nameAr: 'تحليلات التجارة الإلكترونية', nameEn: 'E-commerce Analytics', icon: 'bar-chart', sortOrder: 16, description: 'تحليل أداء المتاجر والمبيعات.' },
    ],
  },
  {
    slug: 'no-code-automation',
    nameAr: 'أدوات بدون كود وأتمتة',
    nameEn: 'No-code & Automation',
    icon: 'zap',
    description:
      'بناء حلول ومنتجات بدون كود وأتمتة سير العمل باستخدام الأدوات الحديثة.',
    sortOrder: 14,
    specialties: [
      { slug: 'bubble-development', nameAr: 'تطوير Bubble', nameEn: 'Bubble Development', icon: 'circle', sortOrder: 1, description: 'بناء تطبيقات ويب باستخدام Bubble.' },
      { slug: 'webflow-development', nameAr: 'تطوير Webflow', nameEn: 'Webflow Development', icon: 'globe', sortOrder: 2, description: 'تصميم وتطوير مواقع Webflow.' },
      { slug: 'airtable-automation', nameAr: 'أتمتة Airtable', nameEn: 'Airtable Automation', icon: 'grid', sortOrder: 3, description: 'بناء قواعد وأتمتة Airtable.' },
      { slug: 'zapier-make-automation', nameAr: 'أتمتة Zapier وMake', nameEn: 'Zapier & Make Automation', icon: 'zap', sortOrder: 4, description: 'ربط وأتمتة التطبيقات.' },
      { slug: 'notion-systems', nameAr: 'أنظمة Notion', nameEn: 'Notion Systems', icon: 'book', sortOrder: 5, description: 'بناء أنظمة وقوالب Notion.' },
      { slug: 'integromat-make', nameAr: 'أتمتة Make', nameEn: 'Make Automation', icon: 'git-branch', sortOrder: 6, description: 'سيناريوهات أتمتة معقدة.' },
      { slug: 'workflow-automation', nameAr: 'أتمتة سير العمل', nameEn: 'Workflow Automation', icon: 'refresh-cw', sortOrder: 7, description: 'تصميم وأتمتة سير العمل.' },
      { slug: 'api-integration-nocode', nameAr: 'دمج API بدون كود', nameEn: 'No-code API Integration', icon: 'plug', sortOrder: 8, description: 'ربط الأنظمة عبر API بدون كود.' },
      { slug: 'glide-apps', nameAr: 'تطبيقات Glide', nameEn: 'Glide Apps', icon: 'smartphone', sortOrder: 9, description: 'بناء تطبيقات بدون كود بـGlide.' },
      { slug: 'softr-development', nameAr: 'تطوير Softr', nameEn: 'Softr Development', icon: 'layers', sortOrder: 10, description: 'بناء تطبيقات ويب بـSoftr.' },
      { slug: 'framer-design-dev', nameAr: 'تصميم وتطوير Framer', nameEn: 'Framer Design & Dev', icon: 'layout', sortOrder: 11, description: 'مواقع وتفاعلات Framer.' },
      { slug: 'salesforce-admin', nameAr: 'إدارة Salesforce', nameEn: 'Salesforce Administration', icon: 'briefcase', sortOrder: 12, description: 'إعداد وإدارة Salesforce.' },
      { slug: 'hubspot-automation', nameAr: 'أتمتة HubSpot', nameEn: 'HubSpot Automation', icon: 'refresh-cw', sortOrder: 13, description: 'أتمتة التسويق والمبيعات في HubSpot.' },
      { slug: 'business-process-automation', nameAr: 'أتمتة العمليات', nameEn: 'Business Process Automation', icon: 'settings', sortOrder: 14, description: 'أتمتة العمليات التجارية.' },
      { slug: 'chatbot-automation', nameAr: 'أتمتة الشات بوت', nameEn: 'Chatbot Automation', icon: 'bot', sortOrder: 15, description: 'بناء روبوتات محادثة بدون كود.' },
    ],
  },
  {
    slug: 'cybersecurity',
    nameAr: 'أمن سيبراني',
    nameEn: 'Cybersecurity',
    icon: 'shield',
    description:
      'خدمات الأمن السيبراني واختبار الاختراق والاستجابة للحوادث والامتثال.',
    sortOrder: 15,
    specialties: [
      { slug: 'penetration-testing', nameAr: 'اختبار الاختراق', nameEn: 'Penetration Testing', icon: 'shield', sortOrder: 1, description: 'تقييم أمني محاكاة للاختراق.' },
      { slug: 'vulnerability-assessment', nameAr: 'تقييم الثغرات', nameEn: 'Vulnerability Assessment', icon: 'alert-triangle', sortOrder: 2, description: 'اكتشاف وتقييم الثغرات الأمنية.' },
      { slug: 'security-auditing', nameAr: 'التدقيق الأمني', nameEn: 'Security Auditing', icon: 'check-circle', sortOrder: 3, description: 'مراجعة وتدقيق الأنظمة الأمنية.' },
      { slug: 'incident-response', nameAr: 'الاستجابة للحوادث', nameEn: 'Incident Response', icon: 'alert-circle', sortOrder: 4, description: 'الاستجابة والتعامل مع الحوادث الأمنية.' },
      { slug: 'threat-intelligence', nameAr: 'استخبارات التهديدات', nameEn: 'Threat Intelligence', icon: 'eye', sortOrder: 5, description: 'تحليل ومتابعة التهديدات السيبرانية.' },
      { slug: 'security-architecture', nameAr: 'البنية الأمنية', nameEn: 'Security Architecture', icon: 'shield', sortOrder: 6, description: 'تصميم بنية أمنية متكاملة.' },
      { slug: 'cloud-security', nameAr: 'أمن السحابة', nameEn: 'Cloud Security', icon: 'cloud', sortOrder: 7, description: 'تأمين البيئات السحابية.' },
      { slug: 'application-security', nameAr: 'أمن التطبيقات', nameEn: 'Application Security', icon: 'code', sortOrder: 8, description: 'تأمين تطبيقات الويب والجوال.' },
      { slug: 'network-security', nameAr: 'أمن الشبكات', nameEn: 'Network Security', icon: 'network', sortOrder: 9, description: 'حماية وتأمين الشبكات.' },
      { slug: 'compliance-gdpr', nameAr: 'الامتثال (GDPR وغيره)', nameEn: 'Compliance (GDPR etc.)', icon: 'file-text', sortOrder: 10, description: 'دعم الامتثال التنظيمي.' },
      { slug: 'iso-27001', nameAr: 'تطبيق ISO 27001', nameEn: 'ISO 27001 Implementation', icon: 'award', sortOrder: 11, description: 'تطبيق معيار ISO 27001.' },
      { slug: 'security-awareness-training', nameAr: 'تدريب الوعي الأمني', nameEn: 'Security Awareness Training', icon: 'book-open', sortOrder: 12, description: 'تدريب الموظفين على الأمن السيبراني.' },
      { slug: 'siem-management', nameAr: 'إدارة SIEM', nameEn: 'SIEM Management', icon: 'monitor', sortOrder: 13, description: 'إدارة أنظمة SIEM وكشف التهديدات.' },
      { slug: 'identity-access-management', nameAr: 'إدارة الهوية والوصول', nameEn: 'Identity & Access Management', icon: 'key', sortOrder: 14, description: 'حلول IAM وإدارة الصلاحيات.' },
      { slug: 'data-protection-privacy', nameAr: 'حماية البيانات والخصوصية', nameEn: 'Data Protection & Privacy', icon: 'lock', sortOrder: 15, description: 'حماية البيانات وضمان الخصوصية.' },
      { slug: 'malware-analysis', nameAr: 'تحليل البرمجيات الخبيثة', nameEn: 'Malware Analysis', icon: 'bug', sortOrder: 16, description: 'تحليل وفهم البرمجيات الخبيثة.' },
    ],
  },
  {
    slug: 'devops-cloud',
    nameAr: 'ديف أوبس وسحابة',
    nameEn: 'DevOps & Cloud',
    icon: 'cloud',
    description:
      'خدمات DevOps والحوسبة السحابية والبنية التحتية وCI/CD والمراقبة.',
    sortOrder: 16,
    specialties: [
      { slug: 'devops-engineering', nameAr: 'هندسة DevOps', nameEn: 'DevOps Engineering', icon: 'infinity', sortOrder: 1, description: 'بناء وتشغيل عمليات DevOps.' },
      { slug: 'ci-cd-pipelines', nameAr: 'خطوط CI/CD', nameEn: 'CI/CD Pipelines', icon: 'git-branch', sortOrder: 2, description: 'أتمتة التكامل والتسليم المستمر.' },
      { slug: 'aws-cloud', nameAr: 'أمازون ويب سيرفس (AWS)', nameEn: 'AWS Cloud', icon: 'cloud', sortOrder: 3, description: 'إدارة وحلول AWS.' },
      { slug: 'google-cloud-platform', nameAr: 'منصة جوجل السحابية (GCP)', nameEn: 'Google Cloud Platform', icon: 'cloud', sortOrder: 4, description: 'إدارة وحلول GCP.' },
      { slug: 'microsoft-azure', nameAr: 'مايكروسوفت أزور', nameEn: 'Microsoft Azure', icon: 'cloud', sortOrder: 5, description: 'إدارة وحلول Azure.' },
      { slug: 'kubernetes', nameAr: 'كوبرنتيس (Kubernetes)', nameEn: 'Kubernetes', icon: 'box', sortOrder: 6, description: 'إدارة وتنسيق الحاويات.' },
      { slug: 'docker-containerization', nameAr: 'حاويات Docker', nameEn: 'Docker & Containerization', icon: 'package', sortOrder: 7, description: 'تعبئة وتشغيل التطبيقات في حاويات.' },
      { slug: 'terraform-iac', nameAr: 'تيرافورم (IaC)', nameEn: 'Terraform (IaC)', icon: 'code', sortOrder: 8, description: 'البنية التحتية ككود.' },
      { slug: 'infrastructure-automation', nameAr: 'أتمتة البنية التحتية', nameEn: 'Infrastructure Automation', icon: 'settings', sortOrder: 9, description: 'أتمتة إدارة البنية التحتية.' },
      { slug: 'cloud-migration', nameAr: 'الترحيل إلى السحابة', nameEn: 'Cloud Migration', icon: 'cloud', sortOrder: 10, description: 'ترحيل الأنظمة إلى السحابة.' },
      { slug: 'cloud-architecture', nameAr: 'البنية السحابية', nameEn: 'Cloud Architecture', icon: 'sitemap', sortOrder: 11, description: 'تصميم البنى السحابية.' },
      { slug: 'site-reliability-engineering', nameAr: 'هندسة موثوقية الموقع (SRE)', nameEn: 'Site Reliability Engineering', icon: 'activity', sortOrder: 12, description: 'ضمان موثوقية واستقرار الأنظمة.' },
      { slug: 'monitoring-logging', nameAr: 'المراقبة وتسجيل الأحداث', nameEn: 'Monitoring & Logging', icon: 'bar-chart', sortOrder: 13, description: 'إعداد أنظمة المراقبة والسجلات.' },
      { slug: 'serverless-development', nameAr: 'تطوير Serverless', nameEn: 'Serverless Development', icon: 'zap', sortOrder: 14, description: 'بناء دوال بدون خوادم.' },
      { slug: 'cost-optimization-cloud', nameAr: 'تحسين تكاليف السحابة', nameEn: 'Cloud Cost Optimization', icon: 'dollar-sign', sortOrder: 15, description: 'تقليل تكاليف البنية السحابية.' },
      { slug: 'database-administration', nameAr: 'إدارة قواعد البيانات', nameEn: 'Database Administration', icon: 'database', sortOrder: 16, description: 'إدارة وصيانة قواعد البيانات.' },
    ],
  },
  {
    slug: 'games',
    nameAr: 'ألعاب',
    nameEn: 'Games',
    icon: 'gamepad',
    description:
      'تطوير الألعاب وتصميمها وفنها ونشرها على مختلف المنصات.',
    sortOrder: 17,
    specialties: [
      { slug: 'game-development-unity', nameAr: 'تطوير الألعاب بـUnity', nameEn: 'Unity Game Development', icon: 'gamepad', sortOrder: 1, description: 'تطوير ألعاب بمحرك Unity.' },
      { slug: 'game-development-unreal', nameAr: 'تطوير الألعاب بـUnreal', nameEn: 'Unreal Engine Development', icon: 'gamepad', sortOrder: 2, description: 'تطوير ألعاب بمحرك Unreal.' },
      { slug: 'mobile-game-development', nameAr: 'تطوير ألعاب الجوال', nameEn: 'Mobile Game Development', icon: 'smartphone', sortOrder: 3, description: 'تطوير ألعاب iOS وأندرويد.' },
      { slug: 'game-art-design', nameAr: 'فن وتصميم الألعاب', nameEn: 'Game Art & Design', icon: 'palette', sortOrder: 4, description: 'تصميم أصول وبيئات الألعاب.' },
      { slug: '3d-game-modeling', nameAr: 'نمذجة ألعاب ثلاثية الأبعاد', nameEn: '3D Game Modeling', icon: 'box', sortOrder: 5, description: 'نماذج وشخصيات ثلاثية الأبعاد.' },
      { slug: 'game-animation', nameAr: 'أنيميشن الألعاب', nameEn: 'Game Animation', icon: 'film', sortOrder: 6, description: 'تحريك الشخصيات والمشاهد.' },
      { slug: 'game-level-design', nameAr: 'تصميم مستويات الألعاب', nameEn: 'Game Level Design', icon: 'map', sortOrder: 7, description: 'تصميم مستويات ومراحل الألعاب.' },
      { slug: 'game-ui-design', nameAr: 'تصميم واجهات الألعاب', nameEn: 'Game UI Design', icon: 'layout', sortOrder: 8, description: 'تصميم واجهات مستخدم الألعاب.' },
      { slug: 'game-music-sound', nameAr: 'موسيقى وصوت الألعاب', nameEn: 'Game Music & Sound', icon: 'music', sortOrder: 9, description: 'تأليف موسيقى ومؤثرات الألعاب.' },
      { slug: 'game-writing-narrative', nameAr: 'كتابة سيناريو الألعاب', nameEn: 'Game Writing & Narrative', icon: 'book', sortOrder: 10, description: 'كتابة قصص وحوارات الألعاب.' },
      { slug: 'game-testing-qa', nameAr: 'اختبار الألعاب (QA)', nameEn: 'Game Testing & QA', icon: 'check-circle', sortOrder: 11, description: 'اختبار وضمان جودة الألعاب.' },
      { slug: 'ar-vr-development', nameAr: 'تطوير الواقع المعزز والافتراضي', nameEn: 'AR & VR Development', icon: 'glasses', sortOrder: 12, description: 'تطوير تطبيقات AR وVR.' },
      { slug: 'game-monetization', nameAr: 'تحقيق الدخل من الألعاب', nameEn: 'Game Monetization', icon: 'dollar-sign', sortOrder: 13, description: 'استراتيجيات تحقيق الدخل.' },
      { slug: 'game-publishing', nameAr: 'نشر الألعاب', nameEn: 'Game Publishing', icon: 'upload', sortOrder: 14, description: 'نشر الألعاب على المتاجر.' },
      { slug: 'multiplayer-networking', nameAr: 'شبكات الألعاب متعددة اللاعبين', nameEn: 'Multiplayer Networking', icon: 'network', sortOrder: 15, description: 'بناء أنظمة متعددة اللاعبين.' },
    ],
  },
  {
    slug: 'legal-services',
    nameAr: 'خدمات قانونية',
    nameEn: 'Legal Services',
    icon: 'scale',
    description:
      'خدمات قانونية واستشارات وصياغة عقود وملكية فكرية وامتثال.',
    sortOrder: 18,
    specialties: [
      { slug: 'contract-law', nameAr: 'قانون العقود', nameEn: 'Contract Law', icon: 'file-text', sortOrder: 1, description: 'صياغة ومراجعة العقود.' },
      { slug: 'corporate-law', nameAr: 'قانون الشركات', nameEn: 'Corporate Law', icon: 'briefcase', sortOrder: 2, description: 'استشارات قانون الشركات.' },
      { slug: 'intellectual-property', nameAr: 'الملكية الفكرية', nameEn: 'Intellectual Property', icon: 'copyright', sortOrder: 3, description: 'تسجيل وحماية العلامات والبراءات.' },
      { slug: 'employment-law', nameAr: 'قانون العمل', nameEn: 'Employment Law', icon: 'users', sortOrder: 4, description: 'استشارات قانون العمل.' },
      { slug: 'tax-law', nameAr: 'القانون الضريبي', nameEn: 'Tax Law', icon: 'percent', sortOrder: 5, description: 'استشارات ضريبية قانونية.' },
      { slug: 'privacy-law-gdpr', nameAr: 'قانون الخصوصية (GDPR)', nameEn: 'Privacy Law (GDPR)', icon: 'lock', sortOrder: 6, description: 'امتثال قوانين الخصوصية.' },
      { slug: 'terms-conditions-privacy', nameAr: 'صياغة الشروط والسياسات', nameEn: 'Terms, Conditions & Privacy', icon: 'file-text', sortOrder: 7, description: 'صياغة سياسات المواقع والتطبيقات.' },
      { slug: 'commercial-law', nameAr: 'القانون التجاري', nameEn: 'Commercial Law', icon: 'briefcase', sortOrder: 8, description: 'استشارات قانونية تجارية.' },
      { slug: 'dispute-resolution', nameAr: 'تسوية المنازعات', nameEn: 'Dispute Resolution', icon: 'scale', sortOrder: 9, description: 'وساطة وتسوية المنازعات.' },
      { slug: 'immigration-law', nameAr: 'قانون الهجرة', nameEn: 'Immigration Law', icon: 'globe', sortOrder: 10, description: 'استشارات قانون الهجرة.' },
      { slug: 'real-estate-law', nameAr: 'قانون العقارات', nameEn: 'Real Estate Law', icon: 'home', sortOrder: 11, description: 'استشارات قانونية عقارية.' },
      { slug: 'family-law', nameAr: 'قانون الأسرة', nameEn: 'Family Law', icon: 'users', sortOrder: 12, description: 'استشارات قانون الأسرة.' },
      { slug: 'legal-consulting', nameAr: 'استشارات قانونية', nameEn: 'Legal Consulting', icon: 'scale', sortOrder: 13, description: 'استشارات قانونية عامة.' },
      { slug: 'legal-research', nameAr: 'البحوث القانونية', nameEn: 'Legal Research', icon: 'search', sortOrder: 14, description: 'أبحاث قانونية متخصصة.' },
      { slug: 'compliance-regulatory', nameAr: 'الامتثال التنظيمي', nameEn: 'Compliance & Regulatory', icon: 'shield', sortOrder: 15, description: 'دعم الامتثال التنظيمي.' },
      { slug: 'contract-review', nameAr: 'مراجعة العقود', nameEn: 'Contract Review', icon: 'check-circle', sortOrder: 16, description: 'مراجعة وتدقيق العقود.' },
    ],
  },
  {
    slug: 'lifestyle-misc',
    nameAr: 'خدمات متنوعة',
    nameEn: 'Lifestyle & Misc',
    icon: 'sparkles',
    description:
      'خدمات متنوعة ونمط حياة تشمل الاستشارات الحياتية والصحة والتغذية والتنظيم.',
    sortOrder: 19,
    specialties: [
      { slug: 'life-coaching', nameAr: 'تدريب الحياة', nameEn: 'Life Coaching', icon: 'user', sortOrder: 1, description: 'توجيه وتطوير الذات.' },
      { slug: 'health-wellness-coaching', nameAr: 'تدريب الصحة والعافية', nameEn: 'Health & Wellness Coaching', icon: 'heart', sortOrder: 2, description: 'إرشاد نحو حياة صحية.' },
      { slug: 'nutrition-diet-planning', nameAr: 'التغذية وتخطيط الحمية', nameEn: 'Nutrition & Diet Planning', icon: 'apple', sortOrder: 3, description: 'خطط غذائية مخصصة.' },
      { slug: 'fitness-coaching', nameAr: 'تدريب اللياقة', nameEn: 'Fitness Coaching', icon: 'activity', sortOrder: 4, description: 'برامج لياقة بدنية.' },
      { slug: 'personal-organization', nameAr: 'التنظيم الشخصي', nameEn: 'Personal Organization', icon: 'check-square', sortOrder: 5, description: 'تنظيم المهام والوقت.' },
      { slug: 'event-planning', nameAr: 'تنظيم الفعاليات', nameEn: 'Event Planning', icon: 'calendar', sortOrder: 6, description: 'تخطيط وإدارة الفعاليات.' },
      { slug: 'travel-consulting', nameAr: 'استشارات السفر', nameEn: 'Travel Consulting', icon: 'plane', sortOrder: 7, description: 'تخطيط وتنظيم الرحلات.' },
      { slug: 'personal-branding', nameAr: 'العلامة الشخصية', nameEn: 'Personal Branding', icon: 'star', sortOrder: 8, description: 'بناء العلامة الشخصية.' },
      { slug: 'career-coaching', nameAr: 'تدريب المسار المهني', nameEn: 'Career Coaching', icon: 'briefcase', sortOrder: 9, description: 'إرشاد المسار المهني.' },
      { slug: 'photography-services', nameAr: 'خدمات التصوير', nameEn: 'Photography Services', icon: 'camera', sortOrder: 10, description: 'تصوير احترافي متنوع.' },
      { slug: 'astrology-tarot', nameAr: 'الأبراج والطالع', nameEn: 'Astrology & Tarot', icon: 'star', sortOrder: 11, description: 'قراءة الأبراج والطالع.' },
      { slug: 'home-organization', nameAr: 'تنظيم المنزل', nameEn: 'Home Organization', icon: 'home', sortOrder: 12, description: 'تنظيم وترتيب المنزل.' },
      { slug: 'relationship-coaching', nameAr: 'تدريب العلاقات', nameEn: 'Relationship Coaching', icon: 'heart', sortOrder: 13, description: 'إرشاد في العلاقات الشخصية.' },
      { slug: 'mindfulness-meditation', nameAr: 'اليقظة والتأمل', nameEn: 'Mindfulness & Meditation', icon: 'sun', sortOrder: 14, description: 'توجيه جلسات التأمل.' },
      { slug: 'misc-services', nameAr: 'خدمات أخرى', nameEn: 'Miscellaneous Services', icon: 'sparkles', sortOrder: 15, description: 'خدمات متنوعة إضافية.' },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Seed logic                                                                  */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log('🌱 Seeding marketplace taxonomy (v1)...');

  // Detect duplicate slugs within the taxonomy itself (defensive guard).
  const categorySlugs = new Set<string>();
  const specialtySlugs = new Set<string>();
  for (const cat of TAXONOMY) {
    if (categorySlugs.has(cat.slug)) {
      throw new Error(`Duplicate category slug in taxonomy: ${cat.slug}`);
    }
    categorySlugs.add(cat.slug);
    for (const spec of cat.specialties) {
      if (specialtySlugs.has(spec.slug)) {
        throw new Error(`Duplicate specialty slug in taxonomy: ${spec.slug}`);
      }
      specialtySlugs.add(spec.slug);
    }
  }

  let categoriesCount = 0;
  let specialtiesCount = 0;

  for (const cat of TAXONOMY) {
    const category = await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {
        nameAr: cat.nameAr,
        nameEn: cat.nameEn,
        icon: cat.icon,
        description: cat.description,
        sortOrder: cat.sortOrder,
        isActive: true,
      },
      create: {
        slug: cat.slug,
        nameAr: cat.nameAr,
        nameEn: cat.nameEn,
        icon: cat.icon,
        description: cat.description,
        sortOrder: cat.sortOrder,
        isActive: true,
      },
    });
    categoriesCount++;

    for (const spec of cat.specialties) {
      await prisma.specialty.upsert({
        where: { slug: spec.slug },
        update: {
          categoryId: category.id,
          nameAr: spec.nameAr,
          nameEn: spec.nameEn,
          icon: spec.icon,
          description: spec.description,
          sortOrder: spec.sortOrder,
          isActive: true,
        },
        create: {
          slug: spec.slug,
          categoryId: category.id,
          nameAr: spec.nameAr,
          nameEn: spec.nameEn,
          icon: spec.icon,
          description: spec.description,
          sortOrder: spec.sortOrder,
          isActive: true,
          isCustom: false,
        },
      });
      specialtiesCount++;
    }
  }

  console.log('✅ Marketplace taxonomy seed complete.');
  console.log(`   Categories upserted : ${categoriesCount}`);
  console.log(`   Specialties upserted: ${specialtiesCount}`);
}

main()
  .catch((error) => {
    console.error('❌ Taxonomy seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
