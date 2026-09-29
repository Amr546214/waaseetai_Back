/**
 * Visual-audit seed — populates a LOCAL database with rich, realistic sample
 * data so every list/detail screen renders real content instead of empty
 * states (projects, proposals, contracts, escrow, chat, disputes, reviews,
 * wallet history, notifications, coupons/offers + backing orders and
 * redemptions, accreditation samples, withdrawals, marketer referrals...).
 *
 * Prerequisites: the base accounts already exist (seed.ts / seed-e2e.ts or
 * equivalent): client@test.com, provider@test.com, provider-company@test.com
 * (with its CompanyTeamMember rows), marketer@test.com and one SUPER_ADMIN.
 *
 * Idempotent: every row uses a deterministic UUID derived from a stable key
 * (see vid()) and is upserted, or a natural unique key upsert where the
 * schema has one — re-running refreshes the data (and re-anchors all dates
 * relative to "now" so time-windowed KPIs stay populated) without duplicates.
 *
 * Safety: refuses to run unless SEED_VISUAL_AUDIT=true, DATABASE_URL is set
 * explicitly (no .env is loaded) and points at localhost/127.0.0.1.
 *
 *   SEED_VISUAL_AUDIT=true DATABASE_URL="postgresql://...@localhost:5433/..." \
 *     npx tsx prisma/seed-visual-audit.ts
 */
import { createHash } from 'crypto';
import {
  AccountType,
  AccreditationStatus,
  ContractStatus,
  DisputeStatus,
  EscrowStatus,
  NotificationCategory,
  OrderStatus,
  Prisma,
  PrismaClient,
  ProjectStageStatus,
  ProjectStatus,
  ProposalStatus,
  RequestStatus,
  SpecialtyVerificationStatus,
  UserStatus,
  WithdrawalStatus,
} from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';

if (process.env.SEED_VISUAL_AUDIT !== 'true') {
  console.error('Set SEED_VISUAL_AUDIT=true to run the visual-audit seed (local databases only).');
  process.exit(1);
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL must be set explicitly (this script never loads .env).');
const dbHost = new URL(connectionString).hostname;
if (!['localhost', '127.0.0.1'].includes(dbHost) || process.env.NODE_ENV === 'production') {
  throw new Error(`Refusing to seed non-local database host "${dbHost}".`);
}

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// ─── helpers ──────────────────────────────────────────────────────────────
/** Deterministic RFC-4122-shaped (v4 layout) UUID from a stable key. */
function vid(key: string): string {
  const h = createHash('sha1').update(`waseet-visual-audit:${key}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number, hours = 0) => new Date(NOW.getTime() - d * DAY - hours * 60 * 60 * 1000);
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * DAY);
const round2 = (n: number) => Math.round(n * 100) / 100;
const img = (seed: string, w = 800, h = 600) => `https://picsum.photos/seed/${seed}/${w}/${h}`;

type Delegate = { upsert: (args: any) => Promise<any> };
/** Upsert by primary key; `data` is used for both create and update. */
async function up<T = any>(delegate: Delegate, id: string, data: Record<string, unknown>): Promise<T> {
  return delegate.upsert({ where: { id }, create: { id, ...data }, update: data });
}

const counts: Record<string, number> = {};
const tally = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };

async function requireUser(email: string) {
  const u = await prisma.user.findUnique({ where: { email }, include: { providerProfile: true, clientProfile: true, affiliateProfile: true } });
  if (!u) throw new Error(`Base account ${email} is missing — run the base seeds first.`);
  return u;
}
async function specialtyBySlug(slug: string) {
  const s = await prisma.specialty.findUnique({ where: { slug } });
  if (!s) throw new Error(`Specialty "${slug}" missing — run seed-marketplace-taxonomy.ts first.`);
  return s;
}

async function main() {
  // ─── base accounts ──────────────────────────────────────────────────────
  const client = await requireUser('client@test.com');
  const provider = await requireUser('provider@test.com');
  const company = await requireUser('provider-company@test.com');
  const marketer = await requireUser('marketer@test.com');
  const admin = await prisma.user.findFirst({ where: { accountType: { in: [AccountType.SUPER_ADMIN, AccountType.ADMIN] } }, orderBy: { createdAt: 'asc' } });
  if (!admin) throw new Error('No ADMIN/SUPER_ADMIN user found.');
  if (!provider.providerProfile || !company.providerProfile) throw new Error('Provider profiles missing.');
  if (!marketer.affiliateProfile) throw new Error('Marketer affiliate profile missing.');
  const clientProfile = client.clientProfile ?? await prisma.clientProfile.create({ data: { userId: client.id } });

  const sara = await prisma.companyTeamMember.findUnique({ where: { companyOwnerId_email: { companyOwnerId: company.id, email: 'sara@test.com' } } });
  const fahad = await prisma.companyTeamMember.findUnique({ where: { companyOwnerId_email: { companyOwnerId: company.id, email: 'fahad@test.com' } } });
  if (!sara || !fahad) throw new Error('Company team members sara@test.com / fahad@test.com missing.');

  const sp = {
    fe: await specialtyBySlug('web-development-front-end'),
    be: await specialtyBySlug('web-development-back-end'),
    ux: await specialtyBySlug('ui-ux-design'),
    brand: await specialtyBySlug('logo-brand-identity'),
    mobile: await specialtyBySlug('cross-platform-mobile'),
    seo: await specialtyBySlug('seo-search-engine-optimization'),
    web: await specialtyBySlug('web-design'),
    video: await specialtyBySlug('video-editing'),
    content: await specialtyBySlug('content-writing'),
  };

  // ─── profile enrichment (display fields only; never credentials) ────────
  await prisma.providerProfile.update({
    where: { userId: provider.id },
    data: {
      headline: 'مطور واجهات أمامية وخلفية | React · Next.js · Node.js',
      bio: 'مطور ويب بخبرة 7 سنوات في بناء المتاجر الإلكترونية ولوحات التحكم وتطبيقات SaaS لعملاء في السعودية والخليج. أركّز على الأداء وتجربة المستخدم والتسليم في الوقت المحدد.',
      hourlyRate: 45, yearsOfExperience: 7, city: 'الرياض', country: 'السعودية', location: 'الرياض، السعودية',
      mainSpecialty: sp.fe.nameAr, subSpecialties: ['React', 'Next.js', 'Node.js', 'Tailwind CSS'],
      languages: ['العربية', 'الإنجليزية'], rating: 4.8, isVerified: true,
      githubUrl: 'https://github.com/example-dev', linkedinUrl: 'https://www.linkedin.com/in/example-dev',
    },
  });
  await prisma.providerProfile.update({
    where: { userId: company.id },
    data: {
      companyName: 'وكالة الإبداع الرقمي',
      headline: 'وكالة رقمية متكاملة: هوية بصرية · تطبيقات · تسويق رقمي',
      bio: 'فريق من 12 متخصصاً في التصميم والتطوير والتسويق الرقمي، نفّذنا أكثر من 140 مشروعاً لعلامات تجارية ناشئة وشركات متوسطة في المملكة.',
      yearsOfExperience: 9, city: 'جدة', country: 'السعودية', location: 'جدة، السعودية',
      mainSpecialty: sp.brand.nameAr, subSpecialties: ['هوية بصرية', 'Flutter', 'SEO', 'موشن جرافيك'],
      languages: ['العربية', 'الإنجليزية'], rating: 4.7, isVerified: true, websiteUrl: 'https://example-agency.sa',
    },
  });
  await prisma.user.update({ where: { id: provider.id }, data: { city: 'الرياض', ratingAverage: 4.8, completedProjectsCount: 1, tierLevel: 'Silver' } });
  await prisma.user.update({ where: { id: company.id }, data: { city: 'جدة', ratingAverage: 4.7, completedProjectsCount: 2, tierLevel: 'Gold' } });
  if (company.marketingMonthlySpendCap == null) {
    await prisma.user.update({ where: { id: company.id }, data: { marketingMonthlySpendCap: 6000 } });
  }
  if (!marketer.affiliateProfile.referralSlug) {
    const slugTaken = await prisma.affiliateProfile.findUnique({ where: { referralSlug: 'wasit-marketer' } });
    if (!slugTaken) await prisma.affiliateProfile.update({ where: { id: marketer.affiliateProfile.id }, data: { referralSlug: 'wasit-marketer' } });
  }
  await prisma.affiliateProfile.update({
    where: { id: marketer.affiliateProfile.id },
    data: {
      bio: 'صانع محتوى تقني ومسوّق بالعمولة، أساعد الشركات الناشئة على إيجاد مزودي الخدمات المناسبين.',
      bankName: 'مصرف الراجحي', accountHolderName: 'وسيط تسويقي', iban: 'SA0380000000608010167519', completionPercentage: 85,
    },
  });

  // ─── extra customers (order redemptions, referrals, open requests) ──────
  const pw = await bcrypt.hash('ClientTest12345', 10);
  const extraDefs = [
    { key: 'nora', first: 'نورة', last: 'القحطاني', type: AccountType.CLIENT_INDIVIDUAL, city: 'الرياض' },
    { key: 'khalid', first: 'خالد', last: 'الشمري', type: AccountType.CLIENT_INDIVIDUAL, city: 'الدمام' },
    { key: 'reem', first: 'ريم', last: 'الدوسري', type: AccountType.CLIENT_INDIVIDUAL, city: 'الخبر' },
    { key: 'majed', first: 'ماجد', last: 'الحربي', type: AccountType.CLIENT_INDIVIDUAL, city: 'المدينة المنورة' },
    { key: 'lama', first: 'لمى', last: 'العنزي', type: AccountType.CLIENT_COMPANY, city: 'جدة', companyName: 'شركة نخبة التجارة' },
    { key: 'turki', first: 'تركي', last: 'السبيعي', type: AccountType.CLIENT_INDIVIDUAL, city: 'مكة المكرمة' },
  ];
  const ex: Record<string, { id: string; firstName: string; lastName: string; profileId: string }> = {};
  for (const [i, d] of extraDefs.entries()) {
    const email = `va.${d.key}@test.com`;
    const u = await prisma.user.upsert({
      where: { email },
      update: { city: d.city },
      create: {
        id: vid(`user:${d.key}`), email, firstName: d.first, lastName: d.last, password: pw,
        phoneNumber: `05500001${String(i + 1).padStart(2, '0')}`, phoneCountryCode: '+966',
        accountType: d.type, status: UserStatus.ACTIVE, roles: ['CLIENT'], activeRole: 'CLIENT',
        agreedToTerms: true, profileCompletionPercent: 80, city: d.city, createdAt: daysAgo(150 - i * 12),
      },
    });
    const cp = await prisma.clientProfile.upsert({
      where: { userId: u.id },
      update: {},
      create: { userId: u.id, firstName: d.first, lastName: d.last, city: d.city, companyName: d.companyName ?? null, isProfileComplete: true },
    });
    ex[d.key] = { id: u.id, firstName: u.firstName, lastName: u.lastName, profileId: cp.id };
    tally('User (extra customers)');
  }

  // ─── service catalog ────────────────────────────────────────────────────
  type SvcDef = { key: string; owner: 'P' | 'PC'; title: string; desc: string; specialtyId: string; sub: string; amount: number; days: number; status: string; views: number; sales: number; ai?: number; featured?: boolean; reject?: string; stages: [string, string, string] };
  const svcDefs: SvcDef[] = [
    { key: 'P1', owner: 'P', title: 'تطوير متجر إلكتروني متكامل بـ Next.js', desc: 'متجر إلكتروني سريع ومتوافق مع محركات البحث يشمل سلة الشراء، بوابات الدفع المحلية (مدى، Apple Pay)، لوحة إدارة المنتجات والطلبات، وتكامل مع شركات الشحن.', specialtyId: sp.fe.id, sub: 'Next.js', amount: 1800, days: 21, status: 'PUBLISHED', views: 1240, sales: 9, ai: 92, featured: true, stages: ['تحليل المتطلبات وتصميم الواجهات', 'برمجة المتجر وربط بوابات الدفع', 'الاختبار والإطلاق والتدريب'] },
    { key: 'P2', owner: 'P', title: 'تصميم واجهات تطبيق جوال (UI/UX)', desc: 'تصميم تجربة وواجهات تطبيق جوال كاملة على Figma: بحث المستخدم، خريطة التدفق، النماذج الأولية التفاعلية، ونظام تصميم قابل لإعادة الاستخدام.', specialtyId: sp.ux.id, sub: 'Figma', amount: 950, days: 12, status: 'APPROVED', views: 860, sales: 7, ai: 88, stages: ['بحث المستخدم وخريطة التدفق', 'تصميم الشاشات عالية الدقة', 'النموذج التفاعلي وتسليم الملفات'] },
    { key: 'P3', owner: 'P', title: 'بناء لوحة تحكم إدارية React + Node.js', desc: 'لوحة تحكم لإدارة العمليات الداخلية مع صلاحيات متعددة، تقارير ورسوم بيانية، وواجهة برمجية REST موثقة.', specialtyId: sp.be.id, sub: 'Node.js', amount: 2400, days: 30, status: 'PENDING_APPROVAL', views: 0, sales: 0, stages: ['تصميم قاعدة البيانات والواجهة البرمجية', 'تطوير لوحة التحكم والتقارير', 'الاختبار والنشر'] },
    { key: 'P4', owner: 'P', title: 'تحسين أداء وسرعة موقع ووردبريس', desc: 'تحسين سرعة تحميل موقع ووردبريس ورفع تقييم Core Web Vitals.', specialtyId: sp.web.id, sub: 'WordPress', amount: 400, days: 5, status: 'REJECTED', views: 45, sales: 0, ai: 48, reject: 'وصف الخدمة مختصر جداً ولا يوضح المخرجات القابلة للقياس. يرجى إضافة نطاق العمل ومؤشرات الأداء المستهدفة وأمثلة سابقة.', stages: ['تحليل الأداء الحالي', 'تطبيق التحسينات', 'تقرير النتائج'] },
    { key: 'P5', owner: 'P', title: 'صفحة هبوط تسويقية لإطلاق منتج', desc: 'صفحة هبوط سريعة الاستجابة مع نموذج تسجيل وتكامل مع أدوات التحليلات.', specialtyId: sp.fe.id, sub: 'Landing Page', amount: 600, days: 7, status: 'DRAFT', views: 0, sales: 0, stages: ['الهيكلة والمحتوى', 'التصميم والبرمجة', 'الإطلاق'] },
    { key: 'C1', owner: 'PC', title: 'هوية بصرية متكاملة للشركات الناشئة', desc: 'شعار احترافي بثلاثة مقترحات، لوحة ألوان وخطوط، دليل استخدام الهوية، وتصاميم المطبوعات والسوشال ميديا الأساسية.', specialtyId: sp.brand.id, sub: 'Logo Design', amount: 3200, days: 20, status: 'PUBLISHED', views: 2310, sales: 16, ai: 95, featured: true, stages: ['جلسة الاكتشاف ومقترحات الشعار', 'تطوير الهوية ودليل الاستخدام', 'تصاميم التطبيقات والتسليم النهائي'] },
    { key: 'C2', owner: 'PC', title: 'تطبيق جوال متعدد المنصات (Flutter)', desc: 'تطوير تطبيق iOS وأندرويد بقاعدة كود واحدة مع لوحة تحكم، إشعارات فورية، وتكامل مع بوابات الدفع.', specialtyId: sp.mobile.id, sub: 'Flutter', amount: 8500, days: 45, status: 'PUBLISHED', views: 1780, sales: 6, ai: 90, stages: ['التحليل وتصميم الواجهات', 'تطوير التطبيق ولوحة التحكم', 'الاختبار والنشر على المتاجر'] },
    { key: 'C3', owner: 'PC', title: 'حملة تحسين محركات البحث SEO لمدة 3 أشهر', desc: 'تدقيق تقني شامل، بحث الكلمات المفتاحية، تحسين المحتوى، وبناء روابط خلفية مع تقارير شهرية.', specialtyId: sp.seo.id, sub: 'Technical SEO', amount: 2700, days: 90, status: 'APPROVED', views: 940, sales: 8, ai: 86, stages: ['التدقيق التقني وخطة الكلمات', 'تحسين المحتوى وبناء الروابط', 'التقرير الختامي والتوصيات'] },
    { key: 'C4', owner: 'PC', title: 'موقع تعريفي للشركات', desc: 'موقع تعريفي ثنائي اللغة بتصميم مخصص ولوحة تحكم لإدارة المحتوى.', specialtyId: sp.web.id, sub: 'Corporate Website', amount: 2200, days: 18, status: 'UNDER_REVIEW', views: 310, sales: 3, ai: 81, stages: ['تصميم الواجهات', 'البرمجة وإدارة المحتوى', 'الإطلاق'] },
    { key: 'C5', owner: 'PC', title: 'إنتاج فيديو موشن جرافيك تعريفي', desc: 'فيديو موشن جرافيك مدته 60 ثانية.', specialtyId: sp.video.id, sub: 'Motion Graphics', amount: 1500, days: 10, status: 'REJECTED', views: 12, sales: 0, ai: 52, reject: 'نماذج الأعمال المرفقة لا تطابق تخصص الموشن جرافيك. يرجى إرفاق نماذج فيديو سابقة.', stages: ['السيناريو واللوحة القصصية', 'التحريك والتعليق الصوتي', 'التسليم النهائي'] },
  ];
  const svc: Record<string, { id: string; title: string; amount: number; days: number; owner: 'P' | 'PC'; ai: number }> = {};
  for (const d of svcDefs) {
    const id = vid(`svc:${d.key}`);
    const ownerId = d.owner === 'P' ? provider.id : company.id;
    await up(prisma.serviceCatalog, id, {
      providerId: ownerId, title: d.title, description: d.desc, specialtyId: d.specialtyId, subSpecialty: d.sub,
      gallery: [img(`va-${d.key}-1`), img(`va-${d.key}-2`), img(`va-${d.key}-3`)],
      totalAmount: d.amount, totalDays: d.days, status: d.status,
      aiScore: d.ai ?? null, aiClarityScore: d.ai ? d.ai - 3 : null, aiFeasibilityScore: d.ai ? d.ai - 1 : null,
      aiReviewSummary: d.ai ? (d.reject ? 'الخدمة تحتاج إلى توضيح نطاق العمل والمخرجات.' : 'وصف واضح ومخرجات محددة وسعر ضمن النطاق العادل للسوق.') : null,
      auditRejectionReason: d.reject ?? null,
      approvedAt: ['PUBLISHED', 'APPROVED'].includes(d.status) ? daysAgo(100) : null,
      viewsCount: d.views, salesCount: d.sales, isFeatured: d.featured ?? false, createdAt: daysAgo(d.status === 'DRAFT' ? 2 : 110),
    });
    const pct = [30, 50, 20];
    const dayShare = [0.25, 0.55, 0.2];
    for (let s = 0; s < 3; s++) {
      await up(prisma.serviceStage, vid(`svc:${d.key}:stage:${s + 1}`), {
        serviceId: id, stepOrder: s + 1, title: d.stages[s], description: `${d.stages[s]} — ${d.title}`,
        deliveryDays: Math.max(1, Math.round(d.days * dayShare[s])), percentage: pct[s], computedAmount: round2((d.amount * pct[s]) / 100),
      });
      tally('ServiceStage');
    }
    svc[d.key] = { id, title: d.title, amount: d.amount, days: d.days, owner: d.owner, ai: d.ai ?? 0 };
    tally('ServiceCatalog');
  }

  // ─── portfolio ──────────────────────────────────────────────────────────
  const portfolio = [
    { key: 'pf-p1', owner: provider.providerProfile.id, title: 'متجر "عطور الشرق" الإلكتروني', tags: ['Next.js', 'Stripe', 'Tailwind'] },
    { key: 'pf-p2', owner: provider.providerProfile.id, title: 'لوحة تحكم لشركة لوجستية', tags: ['React', 'Node.js', 'PostgreSQL'] },
    { key: 'pf-c1', owner: company.providerProfile.id, title: 'هوية بصرية لمقهى "بن وهيل"', tags: ['Branding', 'Illustrator'] },
    { key: 'pf-c2', owner: company.providerProfile.id, title: 'تطبيق "وصلني" للتوصيل', tags: ['Flutter', 'Firebase'] },
  ];
  for (const p of portfolio) {
    await up(prisma.portfolioItem, vid(p.key), { providerProfileId: p.owner, title: p.title, description: `نموذج أعمال: ${p.title}`, coverImage: img(`va-${p.key}`), projectUrl: 'https://example.com', completionDate: daysAgo(200), tags: p.tags });
    tally('PortfolioItem');
  }

  // ─── identity helpers for orders/projects ───────────────────────────────
  const providerCard = (owner: 'P' | 'PC') => owner === 'P'
    ? { id: provider.id, name: `${provider.firstName} ${provider.lastName}`.trim(), initials: `${provider.firstName[0] ?? ''}${provider.lastName[0] ?? ''}` }
    : { id: company.id, name: 'وكالة الإبداع الرقمي', initials: 'وا' };
  const provUser = (owner: 'P' | 'PC') => (owner === 'P' ? provider : company);

  // ─── projects (+ ClientRequest mirror sharing the same id) ──────────────
  type Bid = { owner: 'P' | 'PC'; status: ProposalStatus; price: number; days: number; score: number };
  type ProjDef = {
    key: string; title: string; desc: string; specialty: { id: string; nameAr: string }; clientKey: 'C' | keyof typeof ex;
    owner: 'P' | 'PC' | null; status: ProjectStatus; requestStatus: RequestStatus | null; budget: number; days: number; startedDaysAgo: number;
    serviceKey?: string; stages?: ProjectStageStatus[]; contractStatus?: ContractStatus; escrow?: EscrowStatus; refundedTo?: number;
    bids: Bid[]; chat?: boolean; milestoneTitles: [string, string, string];
  };
  const S = ProjectStageStatus;
  const projDefs: ProjDef[] = [
    { key: 'PR1', title: 'تطوير متجر إلكتروني لعلامة عطور فاخرة', desc: 'نحتاج متجراً إلكترونياً لعلامة عطور محلية يدعم الدفع بمدى وApple Pay، مع إدارة المخزون وربط شركات الشحن وصفحات منتجات جذابة.', specialty: sp.fe, clientKey: 'C', owner: 'P', status: ProjectStatus.IN_PROGRESS, requestStatus: null, budget: 1800, days: 21, startedDaysAgo: 12, serviceKey: 'P1', stages: [S.APPROVED, S.SUBMITTED, S.PENDING], contractStatus: ContractStatus.ACTIVE, escrow: EscrowStatus.HELD, bids: [{ owner: 'P', status: ProposalStatus.ACCEPTED, price: 1800, days: 21, score: 94 }], chat: true, milestoneTitles: ['تحليل المتطلبات وتصميم الواجهات', 'برمجة المتجر وربط بوابات الدفع', 'الاختبار والإطلاق والتدريب'] },
    { key: 'PR2', title: 'تصميم تطبيق حجز مواعيد لعيادة أسنان', desc: 'تصميم واجهات تطبيق يتيح للمرضى حجز المواعيد وإدارة الملف الطبي وتلقي التذكيرات.', specialty: sp.ux, clientKey: 'C', owner: 'P', status: ProjectStatus.COMPLETED, requestStatus: RequestStatus.COMPLETED, budget: 950, days: 12, startedDaysAgo: 48, stages: [S.APPROVED, S.APPROVED, S.APPROVED], contractStatus: ContractStatus.COMPLETED, escrow: EscrowStatus.RELEASED, bids: [{ owner: 'P', status: ProposalStatus.ACCEPTED, price: 950, days: 12, score: 91 }, { owner: 'PC', status: ProposalStatus.REJECTED, price: 1400, days: 15, score: 78 }], chat: true, milestoneTitles: ['بحث المستخدم وخريطة التدفق', 'تصميم الشاشات عالية الدقة', 'النموذج التفاعلي وتسليم الملفات'] },
    { key: 'PR3', title: 'لوحة تحكم لإدارة مخزون المستودعات', desc: 'نظام ويب لإدارة المخزون عبر عدة مستودعات مع تنبيهات النفاد وتقارير الحركة وصلاحيات المستخدمين.', specialty: sp.be, clientKey: 'C', owner: 'P', status: ProjectStatus.DISPUTED, requestStatus: RequestStatus.IN_PROGRESS, budget: 2400, days: 30, startedDaysAgo: 40, stages: [S.APPROVED, S.REVISION_REQUESTED, S.PENDING], contractStatus: ContractStatus.DISPUTED, escrow: EscrowStatus.HELD, bids: [{ owner: 'P', status: ProposalStatus.ACCEPTED, price: 2400, days: 30, score: 87 }], chat: true, milestoneTitles: ['تصميم قاعدة البيانات والواجهة البرمجية', 'تطوير لوحة التحكم والتقارير', 'الاختبار والنشر'] },
    { key: 'PR4', title: 'صفحة هبوط لإطلاق تطبيق لياقة بدنية', desc: 'صفحة هبوط ثنائية اللغة لجمع التسجيلات المبكرة قبل إطلاق التطبيق، مع تكامل Mailchimp وGoogle Analytics.', specialty: sp.web, clientKey: 'C', owner: null, status: ProjectStatus.OPEN, requestStatus: RequestStatus.OPEN, budget: 700, days: 10, startedDaysAgo: 3, bids: [{ owner: 'P', status: ProposalStatus.SUBMITTED, price: 650, days: 8, score: 89 }, { owner: 'PC', status: ProposalStatus.SUBMITTED, price: 900, days: 10, score: 84 }], milestoneTitles: ['الهيكلة والمحتوى', 'التصميم والبرمجة', 'الإطلاق والربط بالأدوات'] },
    { key: 'PR5', title: 'تحسين سرعة وأداء موقع شركة عقارية', desc: 'رفع تقييم Core Web Vitals لموقع الشركة وتحسين زمن التحميل على الجوال.', specialty: sp.fe, clientKey: 'C', owner: 'P', status: ProjectStatus.AWAITING_DELIVERY, requestStatus: RequestStatus.IN_PROGRESS, budget: 1500, days: 14, startedDaysAgo: 15, stages: [S.APPROVED, S.APPROVED, S.SUBMITTED], contractStatus: ContractStatus.ACTIVE, escrow: EscrowStatus.HELD, bids: [{ owner: 'P', status: ProposalStatus.ACCEPTED, price: 1500, days: 14, score: 90 }], chat: true, milestoneTitles: ['تدقيق الأداء الحالي', 'تطبيق التحسينات', 'تقرير النتائج والتسليم'] },
    { key: 'PR6', title: 'هوية بصرية لمقهى مختص', desc: 'هوية بصرية كاملة لمقهى مختص تشمل الشعار والأكواب والمنيو واللافتات.', specialty: sp.brand, clientKey: 'C', owner: 'PC', status: ProjectStatus.COMPLETED, requestStatus: RequestStatus.COMPLETED, budget: 3200, days: 20, startedDaysAgo: 75, stages: [S.APPROVED, S.APPROVED, S.APPROVED], contractStatus: ContractStatus.COMPLETED, escrow: EscrowStatus.RELEASED, bids: [{ owner: 'PC', status: ProposalStatus.ACCEPTED, price: 3200, days: 20, score: 96 }, { owner: 'P', status: ProposalStatus.REJECTED, price: 2100, days: 18, score: 62 }], chat: true, milestoneTitles: ['جلسة الاكتشاف ومقترحات الشعار', 'تطوير الهوية ودليل الاستخدام', 'تصاميم التطبيقات والتسليم'] },
    { key: 'PR7', title: 'تطبيق توصيل طلبات للمطاعم', desc: 'تطبيق iOS وأندرويد لتوصيل الطلبات مع تتبع السائق مباشرة ولوحة تحكم للمطاعم.', specialty: sp.mobile, clientKey: 'C', owner: 'PC', status: ProjectStatus.IN_PROGRESS, requestStatus: null, budget: 8500, days: 45, startedDaysAgo: 20, serviceKey: 'C2', stages: [S.APPROVED, S.IN_PROGRESS, S.PENDING], contractStatus: ContractStatus.ACTIVE, escrow: EscrowStatus.HELD, bids: [{ owner: 'PC', status: ProposalStatus.ACCEPTED, price: 8500, days: 45, score: 93 }], chat: true, milestoneTitles: ['التحليل وتصميم الواجهات', 'تطوير التطبيق ولوحة التحكم', 'الاختبار والنشر على المتاجر'] },
    { key: 'PR8', title: 'حملة SEO لمتجر أزياء نسائية', desc: 'تحسين ظهور المتجر في نتائج البحث للكلمات التجارية المستهدفة خلال 3 أشهر.', specialty: sp.seo, clientKey: 'C', owner: 'PC', status: ProjectStatus.DISPUTED, requestStatus: RequestStatus.IN_PROGRESS, budget: 2700, days: 90, startedDaysAgo: 60, stages: [S.APPROVED, S.SUBMITTED, S.PENDING], contractStatus: ContractStatus.DISPUTED, escrow: EscrowStatus.HELD, bids: [{ owner: 'PC', status: ProposalStatus.ACCEPTED, price: 2700, days: 90, score: 85 }], chat: true, milestoneTitles: ['التدقيق التقني وخطة الكلمات', 'تحسين المحتوى وبناء الروابط', 'التقرير الختامي'] },
    { key: 'PR9', title: 'موقع تعريفي لمكتب محاماة', desc: 'موقع تعريفي ثنائي اللغة يعرض خدمات المكتب وفريق المحامين مع نموذج حجز استشارة.', specialty: sp.web, clientKey: 'C', owner: 'PC', status: ProjectStatus.COMPLETED, requestStatus: RequestStatus.COMPLETED, budget: 2200, days: 18, startedDaysAgo: 95, stages: [S.APPROVED, S.APPROVED, S.PENDING], contractStatus: ContractStatus.CANCELLED, escrow: EscrowStatus.REFUNDED, refundedTo: 1100, bids: [{ owner: 'PC', status: ProposalStatus.ACCEPTED, price: 2200, days: 18, score: 82 }], chat: true, milestoneTitles: ['تصميم الواجهات', 'البرمجة وإدارة المحتوى', 'الإطلاق'] },
    { key: 'PR10', title: 'تصميم هوية تطبيق مالي ناشئ', desc: 'هوية بصرية ونظام تصميم لتطبيق مدفوعات رقمية موجه للشباب.', specialty: sp.brand, clientKey: 'C', owner: 'PC', status: ProjectStatus.PENDING_SIGNATURE, requestStatus: RequestStatus.PENDING_SIGNATURE, budget: 4100, days: 25, startedDaysAgo: 2, stages: [S.PENDING, S.PENDING, S.PENDING], contractStatus: ContractStatus.PENDING_CLIENT_SIGNATURE, bids: [{ owner: 'PC', status: ProposalStatus.PENDING_SIGNATURE, price: 4100, days: 25, score: 92 }, { owner: 'P', status: ProposalStatus.REJECTED, price: 3000, days: 20, score: 70 }], milestoneTitles: ['الاكتشاف والمقترحات', 'تطوير الهوية ونظام التصميم', 'التسليم النهائي'] },
    { key: 'PR11', title: 'منصة تعليمية للدورات القصيرة', desc: 'مسودة: منصة لبيع الدورات القصيرة بالفيديو مع اختبارات وشهادات.', specialty: sp.be, clientKey: 'C', owner: null, status: ProjectStatus.DRAFT, requestStatus: RequestStatus.DRAFT, budget: 6000, days: 60, startedDaysAgo: 1, bids: [], milestoneTitles: ['التخطيط', 'التطوير', 'الإطلاق'] },
    { key: 'PR12', title: 'كتابة محتوى لموقع عيادة تجميل', desc: 'كتابة 15 صفحة محتوى متوافق مع SEO لموقع عيادة تجميل، مع مقالات مدونة شهرية.', specialty: sp.content, clientKey: 'nora', owner: null, status: ProjectStatus.OPEN, requestStatus: RequestStatus.OPEN, budget: 1200, days: 14, startedDaysAgo: 4, bids: [{ owner: 'PC', status: ProposalStatus.UNDER_NEGOTIATION, price: 1350, days: 14, score: 80 }], milestoneTitles: ['خطة المحتوى', 'كتابة الصفحات', 'المراجعة والتسليم'] },
    { key: 'PR13', title: 'تطوير تطبيق لحجز ملاعب كرة القدم', desc: 'تطبيق يتيح حجز الملاعب بالساعة والدفع الإلكتروني وتقييم الملاعب.', specialty: sp.mobile, clientKey: 'khalid', owner: null, status: ProjectStatus.OPEN, requestStatus: RequestStatus.OPEN, budget: 7000, days: 40, startedDaysAgo: 6, bids: [{ owner: 'PC', status: ProposalStatus.SUBMITTED, price: 7400, days: 42, score: 88 }], milestoneTitles: ['التحليل والتصميم', 'التطوير', 'النشر'] },
    { key: 'PR14', title: 'إعادة تصميم متجر إلكترونيات', desc: 'إعادة تصميم واجهات متجر إلكترونيات قائم لتحسين معدل التحويل.', specialty: sp.ux, clientKey: 'lama', owner: null, status: ProjectStatus.OPEN, requestStatus: RequestStatus.OPEN, budget: 2500, days: 20, startedDaysAgo: 1, bids: [], milestoneTitles: ['تحليل تجربة المستخدم', 'التصميم', 'التسليم'] },
  ];

  const projectIds: Record<string, string> = {};
  const contractIds: Record<string, string> = {};
  const stageIds: Record<string, string[]> = {};
  const clientWalletEscrowRefs: { key: string; amount: number; ref: string; at: Date; title: string }[] = [];

  for (const d of projDefs) {
    const id = vid(`project:${d.key}`);
    projectIds[d.key] = id;
    const clientId = d.clientKey === 'C' ? client.id : ex[d.clientKey].id;
    const clientProfileId = d.clientKey === 'C' ? clientProfile.id : ex[d.clientKey].profileId;
    const createdAt = daysAgo(d.startedDaysAgo + 3);
    const pct = [30, 50, 20];
    const dayShare = [0.25, 0.55, 0.2];

    // ClientRequest mirror first (app convention: request.id === project.id)
    if (d.requestStatus) {
      await up(prisma.clientRequest, id, {
        clientProfileId, specialtyId: d.specialty.id, title: d.title, description: d.desc,
        subSpecialties: [d.specialty.nameAr], requiredSkills: ['خبرة سابقة مماثلة', 'التواصل باللغة العربية'],
        budgetType: 'RANGE', minBudget: round2(d.budget * 0.8), maxBudget: round2(d.budget * 1.2), expectedDurationDays: d.days,
        preferredProviderType: 'ANY', requiresNda: d.key === 'PR3', attachments: [`https://files.example.com/briefs/${d.key.toLowerCase()}-brief.pdf`],
        outputs: 'ملفات المصدر كاملة + دليل الاستخدام', ipRights: 'client', allowNegotiation: true, splitMilestones: true,
        milestones: d.milestoneTitles.map((t, i) => ({ title: t, percentage: pct[i] })),
        aiAnalyzedSummary: `طلب مشروع "${d.title}" في تخصص ${d.specialty.nameAr}. الميزانية المقدرة: ${round2(d.budget * 0.8)} - ${round2(d.budget * 1.2)} $.`,
        aiComplexityRating: d.budget > 4000 ? 'HIGH' : d.budget > 1500 ? 'MEDIUM' : 'LOW',
        status: d.requestStatus, proposalsCount: d.bids.length, createdAt,
      });
      tally('ClientRequest');
    }

    await up(prisma.project, id, {
      title: d.title, description: d.desc, specialty: d.specialty.nameAr, subSpecialties: [d.specialty.nameAr],
      requirements: ['خبرة سابقة مماثلة', 'الالتزام بالمواعيد'], outputs: 'ملفات المصدر كاملة + دليل الاستخدام', deliveryDays: d.days,
      budgetType: d.serviceKey ? 'fixed' : 'range', budgetMin: round2(d.budget * 0.8), budgetMax: round2(d.budget * 1.2), budgetFixed: d.budget,
      splitMilestones: true, milestones: d.milestoneTitles.map((t, i) => ({ title: t, percentage: pct[i] })),
      attachments: [], proposalsCount: d.bids.length, status: d.status, clientId,
      providerId: d.owner ? provUser(d.owner).id : null, serviceCatalogId: d.serviceKey ? svc[d.serviceKey].id : null,
      aiAnalysis: { complexity: d.budget > 4000 ? 'HIGH' : 'MEDIUM', fairPriceMin: round2(d.budget * 0.85), fairPriceMax: round2(d.budget * 1.15) },
      createdAt,
    });
    tally('Project');

    // Proposals — ProjectProposal (+ milestones) and the legacy Proposal row
    let acceptedPP: string | null = null;
    for (const b of d.bids) {
      const ppId = vid(`pp:${d.key}:${b.owner}`);
      const bidder = provUser(b.owner);
      await prisma.projectProposal.upsert({
        where: { projectId_providerId: { projectId: id, providerId: bidder.id } },
        create: { id: ppId, projectId: id, providerId: bidder.id, title: `عرض ${b.owner === 'P' ? 'مطور مستقل' : 'وكالة الإبداع الرقمي'} لتنفيذ المشروع`.slice(0, 80), message: `مرحباً، اطلعت على تفاصيل مشروع "${d.title}" ولدي خبرة مباشرة في مشاريع مماثلة. أقترح تنفيذ العمل على ثلاث مراحل واضحة مع تسليمات قابلة للمراجعة في كل مرحلة.`, advantages: ['خبرة +5 سنوات في نفس المجال', 'دعم فني مجاني 30 يوماً بعد التسليم', 'تقارير تقدم أسبوعية'], outputs: 'ملفات المصدر + توثيق كامل', portfolioIds: [], totalPrice: b.price, deliveryDays: b.days, status: b.status, aiMatchScore: b.score, aiQualityTag: b.score >= 85 ? 'EXCELLENT' : 'GOOD', aiPriceTag: b.price > d.budget * 1.1 ? 'ABOVE_MARKET' : 'FAIR', aiFeedback: { summary: 'عرض متوازن مع خطة عمل واضحة.' }, agreedToTerms: true, agreedToEscrow: true, createdAt: daysAgo(d.startedDaysAgo + 1) },
        update: { totalPrice: b.price, deliveryDays: b.days, status: b.status, aiMatchScore: b.score, createdAt: daysAgo(d.startedDaysAgo + 1) },
      });
      const pp = await prisma.projectProposal.findUniqueOrThrow({ where: { projectId_providerId: { projectId: id, providerId: bidder.id } } });
      if (b.status === ProposalStatus.ACCEPTED || b.status === ProposalStatus.PENDING_SIGNATURE) acceptedPP = pp.id;
      for (let s = 0; s < 3; s++) {
        await up(prisma.proposalMilestone, vid(`pp:${d.key}:${b.owner}:m${s + 1}`), {
          proposalId: pp.id, stepOrder: s + 1, title: d.milestoneTitles[s], description: `تفاصيل المرحلة: ${d.milestoneTitles[s]}`,
          days: Math.max(1, Math.round(b.days * dayShare[s])), percentage: pct[s], amount: round2((b.price * pct[s]) / 100),
        });
        tally('ProposalMilestone');
      }
      tally('ProjectProposal');
      if (d.requestStatus) {
        await up(prisma.proposal, vid(`proposal:${d.key}:${b.owner}`), {
          clientRequestId: id, providerId: bidder.id, price: b.price, deliveryDays: b.days, aiMatchScore: b.score, status: b.status,
          coverLetter: `يسعدني تقديم عرضي لمشروع "${d.title}". نفذت مشاريع مشابهة لعملاء في قطاعات مختلفة ويمكنني البدء فوراً.`,
          workPlan: d.milestoneTitles.map((t, i) => `${i + 1}. ${t}`).join('\n'),
          aiFairPriceMin: round2(d.budget * 0.85), aiFairPriceMax: round2(d.budget * 1.15), aiPriceTag: 'FAIR', createdAt: daysAgo(d.startedDaysAgo + 1),
        });
        tally('Proposal (legacy)');
      }
    }

    // Contract + stages + deliveries
    if (d.owner && d.contractStatus && d.stages) {
      const contractId = vid(`contract:${d.key}`);
      contractIds[d.key] = contractId;
      const signed = d.contractStatus !== ContractStatus.PENDING_CLIENT_SIGNATURE;
      await up(prisma.contract, contractId, {
        projectId: id, clientId, providerId: provUser(d.owner).id, offerId: acceptedPP, price: d.budget, durationDays: d.days, phasesCount: 3,
        terms: ['تسليم ملفات المصدر كاملة', 'حقوق الملكية الفكرية للعميل بعد السداد', 'تعديلان مجانيان لكل مرحلة', 'الدفع عبر الضمان المالي لوسيط AI'],
        status: d.contractStatus, clientSignedAt: signed ? daysAgo(d.startedDaysAgo) : null, providerSignedAt: daysAgo(d.startedDaysAgo + 0.5),
        signedAt: signed ? daysAgo(d.startedDaysAgo) : null, createdAt: daysAgo(d.startedDaysAgo + 1),
      });
      tally('Contract');
      stageIds[d.key] = [];
      let elapsed = 0;
      for (let s = 0; s < 3; s++) {
        const stId = vid(`stage:${d.key}:${s + 1}`);
        stageIds[d.key].push(stId);
        const st = d.stages[s];
        const days = Math.max(1, Math.round(d.days * dayShare[s]));
        const startedAt = st === S.PENDING ? null : daysAgo(Math.max(0.5, d.startedDaysAgo - elapsed));
        elapsed += days;
        const approvedAt = st === S.APPROVED ? daysAgo(Math.max(0.2, d.startedDaysAgo - elapsed)) : null;
        await prisma.projectStage.upsert({
          where: { contractId_stepOrder: { contractId, stepOrder: s + 1 } },
          create: { id: stId, contractId, stepOrder: s + 1, title: d.milestoneTitles[s], description: `تفاصيل المرحلة: ${d.milestoneTitles[s]}`, days, percentage: pct[s], amount: round2((d.budget * pct[s]) / 100), status: st, startedAt, approvedAt },
          update: { title: d.milestoneTitles[s], days, percentage: pct[s], amount: round2((d.budget * pct[s]) / 100), status: st, startedAt, approvedAt },
        });
        const stage = await prisma.projectStage.findUniqueOrThrow({ where: { contractId_stepOrder: { contractId, stepOrder: s + 1 } } });
        stageIds[d.key][s] = stage.id;
        tally('ProjectStage');
        if (st === S.APPROVED || st === S.SUBMITTED || st === S.REVISION_REQUESTED) {
          const submittedAt = approvedAt ? new Date(approvedAt.getTime() - DAY) : daysAgo(1);
          await up(prisma.stageDelivery, vid(`delivery:${d.key}:${s + 1}`), {
            stageId: stage.id, providerId: provUser(d.owner).id,
            note: `تم الانتهاء من "${d.milestoneTitles[s]}". مرفق الملفات ورابط المعاينة، بانتظار ملاحظاتكم.`,
            files: [`https://files.example.com/deliveries/${d.key.toLowerCase()}-stage${s + 1}.zip`, img(`va-del-${d.key}-${s}`)],
            status: st === S.APPROVED ? 'APPROVED' : st === S.SUBMITTED ? 'SUBMITTED' : 'REVISION_REQUESTED',
            reviewNote: st === S.APPROVED ? 'عمل ممتاز، تم الاعتماد.' : st === S.REVISION_REQUESTED ? 'التقارير لا تعرض بيانات المستودع الثاني، يرجى المعالجة.' : null,
            submittedAt, reviewedAt: st === S.SUBMITTED ? null : new Date(submittedAt.getTime() + DAY / 2),
          });
          tally('StageDelivery');
        }
      }

      // Escrow — releasedAmount == sum of APPROVED stage amounts (what provider-finance reads)
      if (d.escrow) {
        const released = d.refundedTo ?? round2(d.stages.reduce((a, st, i) => a + (st === S.APPROVED ? (d.budget * pct[i]) / 100 : 0), 0));
        const ref = `VA-ESC-${d.key}`;
        await up(prisma.escrow, vid(`escrow:${d.key}`), {
          projectId: id, amount: d.budget, status: d.escrow, paymentMethod: 'WALLET', paymentReference: ref,
          fundedAt: daysAgo(d.startedDaysAgo), releasedAmount: released, createdAt: daysAgo(d.startedDaysAgo),
        });
        tally('Escrow');
        clientWalletEscrowRefs.push({ key: d.key, amount: d.budget, ref, at: daysAgo(d.startedDaysAgo), title: d.title });
      }
    }

    // Conversation + messages
    if (d.chat && d.owner) {
      const pu = provUser(d.owner);
      const convId = vid(`conv:${d.key}`);
      await prisma.conversation.upsert({
        where: { projectId_providerId: { projectId: id, providerId: pu.id } },
        create: { id: convId, projectId: id, clientId, providerId: pu.id, offerId: acceptedPP },
        update: { clientId, offerId: acceptedPP },
      });
      const conv = await prisma.conversation.findUniqueOrThrow({ where: { projectId_providerId: { projectId: id, providerId: pu.id } } });
      tally('Conversation');
      const script: { from: 'C' | 'P'; text: string; type?: 'TEXT' | 'FILE' | 'SYSTEM'; file?: string }[] = [
        { from: 'P', type: 'SYSTEM', text: 'تم توقيع العقد وإيداع المبلغ في الضمان المالي. يمكنكم بدء العمل.' },
        { from: 'C', text: `أهلاً، سعيد بالعمل معكم على "${d.title}". هل تحتاجون أي ملفات إضافية للبدء؟` },
        { from: 'P', text: 'أهلاً بك! نحتاج الشعار بصيغة SVG وأي أمثلة لمواقع أو تطبيقات تعجبك في نفس المجال.' },
        { from: 'C', type: 'FILE', text: 'مرفق ملف الهوية والأمثلة المرجعية.', file: 'brand-assets.zip' },
        { from: 'P', text: 'تم الاستلام، شكراً. سأرسل لكم أول تحديث خلال يومين إن شاء الله.' },
        { from: 'P', text: `تم رفع تسليم المرحلة الأولى "${d.milestoneTitles[0]}"، بانتظار مراجعتكم.` },
        { from: 'C', text: d.status === ProjectStatus.DISPUTED ? 'للأسف التسليم لا يطابق المتفق عليه في العقد، سأفتح نزاعاً لمراجعة الموضوع.' : 'ممتاز جداً، تم الاعتماد. استمروا بنفس المستوى 👍' },
      ];
      for (const [i, m] of script.entries()) {
        await up(prisma.message, vid(`msg:${d.key}:${i}`), {
          conversationId: conv.id, senderId: m.from === 'C' ? clientId : pu.id, type: m.type ?? 'TEXT', content: m.text,
          status: i < script.length - 1 ? 'READ' : 'DELIVERED',
          fileUrl: m.file ? `https://files.example.com/chat/${m.file}` : null, fileName: m.file ?? null, fileSize: m.file ? 2_480_000 : null,
          context: i === 5 ? { type: 'STAGE_DELIVERY', projectId: id, stageOrder: 1 } : Prisma.DbNull,
          createdAt: daysAgo(Math.max(0.1, d.startedDaysAgo - i * (d.startedDaysAgo / (script.length + 1)))),
        });
        tally('Message');
      }
    }
  }

  // Amendment on the active delivery-app project
  await up(prisma.projectAmendment, vid('amend:PR7'), {
    projectId: projectIds.PR7, contractId: contractIds.PR7, clientId: client.id, providerId: company.id, requestedById: client.id, requestedByRole: 'CLIENT',
    type: 'MIXED', title: 'إضافة ميزة المحفظة الإلكترونية داخل التطبيق', description: 'نرغب بإضافة محفظة إلكترونية للمستخدمين لشحن الرصيد والدفع السريع.',
    budgetDelta: 1200, durationDeltaDays: 7, status: 'PENDING_OTHER_PARTY', createdAt: daysAgo(2),
  });
  tally('ProjectAmendment');

  // ─── disputes ───────────────────────────────────────────────────────────
  const disputeDefs = [
    { key: 'D1', proj: 'PR3', opener: client.id, against: provider.id, status: DisputeStatus.OPEN, reason: 'التسليم لا يطابق المواصفات', desc: 'المرحلة الثانية سُلّمت بدون تقارير المستودعات المتعددة المتفق عليها في العقد، وطلبت التعديل مرتين دون استجابة كافية.', days: 3 },
    { key: 'D2', proj: 'PR8', opener: company.id, against: client.id, status: DisputeStatus.UNDER_REVIEW, reason: 'تأخر العميل في اعتماد التسليم', desc: 'تم تسليم المرحلة الثانية منذ أكثر من 14 يوماً ولم يقم العميل بالمراجعة أو الرد رغم التذكير المتكرر.', days: 9 },
    { key: 'D3', proj: 'PR9', opener: client.id, against: company.id, status: DisputeStatus.RESOLVED, reason: 'عدم إكمال المشروع', desc: 'توقف العمل بعد المرحلة الثانية ولم يتم إطلاق الموقع.', days: 40, resolution: 'PARTIAL_REFUND', note: 'تمت مراجعة الأدلة: اعتُمدت المرحلتان الأولى والثانية للمزود (1100$) واسترد العميل المبلغ المتبقي (1100$).' },
    { key: 'D4', proj: 'PR6', opener: client.id, against: company.id, status: DisputeStatus.REJECTED, reason: 'اختلاف درجة اللون في المطبوعات', desc: 'درجة اللون في الأكواب المطبوعة تختلف عن ملف الهوية.', days: 55, resolution: 'NO_ACTION', note: 'الاختلاف ناتج عن المطبعة وليس عن ملفات التصميم المسلّمة، والملفات مطابقة للدليل المعتمد.' },
  ];
  for (const d of disputeDefs) {
    const isReq = projDefs.find(p => p.key === d.proj)?.requestStatus;
    await up(prisma.dispute, vid(`dispute:${d.key}`), {
      projectId: projectIds[d.proj], requestId: isReq ? projectIds[d.proj] : null, openedById: d.opener, againstUserId: d.against,
      status: d.status, reason: d.reason, description: d.desc,
      evidence: [`https://files.example.com/disputes/${d.key.toLowerCase()}-evidence-1.pdf`, img(`va-${d.key}-ev`)],
      resolution: d.resolution ?? null, resolutionNote: d.note ?? null,
      resolvedById: d.resolution ? admin.id : null, resolvedAt: d.resolution ? daysAgo(d.days - 5) : null, createdAt: daysAgo(d.days),
    });
    tally('Dispute');
  }

  // ─── reviews (both directions + marketplace service reviews) ────────────
  const reviewDefs = [
    { key: 'R1', proj: 'PR2', providerId: provider.id, clientId: client.id, role: 'CLIENT', rating: 5, comment: 'تصاميم رائعة وتواصل ممتاز، التزم بالمواعيد وقدّم أفكاراً إضافية مفيدة.', days: 30, service: 'P2' },
    { key: 'R2', proj: 'PR2', providerId: provider.id, clientId: client.id, role: 'PROVIDER', rating: 5, comment: 'عميل متعاون ومتطلباته واضحة، والمراجعات كانت سريعة.', days: 30 },
    { key: 'R3', proj: 'PR6', providerId: company.id, clientId: client.id, role: 'CLIENT', rating: 4.5, comment: 'هوية مميزة جداً ودليل استخدام شامل. تأخير بسيط في المرحلة الأخيرة.', days: 50, service: 'C1' },
    { key: 'R4', proj: 'PR6', providerId: company.id, clientId: client.id, role: 'PROVIDER', rating: 4, comment: 'تجربة جيدة، نتمنى سرعة أكبر في اعتماد التسليمات مستقبلاً.', days: 50 },
    { key: 'R5', proj: null, providerId: provider.id, clientId: ex.reem.id, role: 'CLIENT', rating: 5, comment: 'المتجر سريع جداً والدفع يعمل بلا مشاكل. أنصح به بشدة.', days: 8, service: 'P1' },
    { key: 'R6', proj: null, providerId: provider.id, clientId: ex.khalid.id, role: 'CLIENT', rating: 4, comment: 'عمل احترافي، احتجنا تعديلاً بسيطاً بعد التسليم وتمت الاستجابة سريعاً.', days: 15, service: 'P1' },
    { key: 'R7', proj: null, providerId: company.id, clientId: ex.nora.id, role: 'CLIENT', rating: 5, comment: 'فريق مبدع، الشعار تجاوز توقعاتنا.', days: 20, service: 'C1' },
    { key: 'R8', proj: null, providerId: company.id, clientId: ex.lama.id, role: 'CLIENT', rating: 4.5, comment: 'تطبيق ممتاز وأداء سلس على أندرويد وiOS.', days: 11, service: 'C2' },
  ];
  for (const r of reviewDefs) {
    await up(prisma.review, vid(`review:${r.key}`), {
      providerId: r.providerId, clientId: r.clientId, projectId: r.proj ? projectIds[r.proj] : null,
      serviceId: r.service ? svc[r.service].id : null, reviewerRole: r.role, rating: r.rating, comment: r.comment, createdAt: daysAgo(r.days),
    });
    tally('Review');
  }

  // ─── coupons ────────────────────────────────────────────────────────────
  type CouponDef = { key: string; code: string; owner: 'P' | 'PC'; value: number; type?: 'percentage' | 'fixed'; max?: number; maxUses?: number | null; start: number; expires: number | null; active: boolean; approval: 'APPROVED' | 'PENDING' | 'REJECTED'; reject?: string; services?: string[]; assigned?: string; created?: string; note?: string; minimum?: number };
  const couponDefs: CouponDef[] = [
    { key: 'PROVSTART15', code: 'PROVSTART15', owner: 'P', value: 15, max: 400, maxUses: 50, start: 60, expires: -60, active: true, approval: 'APPROVED', note: 'كوبون ترحيبي للعملاء الجدد من حملة تويتر.' },
    { key: 'SUMMER25', code: 'SUMMER25', owner: 'P', value: 25, max: 500, maxUses: 20, start: 100, expires: 40, active: true, approval: 'APPROVED', note: 'حملة الصيف — انتهت.' },
    { key: 'FIXED100', code: 'FIXED100', owner: 'P', value: 100, type: 'fixed', maxUses: 30, start: 10, expires: -90, active: false, approval: 'APPROVED', minimum: 800, services: ['P1'], note: 'موقوف مؤقتاً.' },
    { key: 'TEAM15', code: 'TEAM15', owner: 'PC', value: 15, max: 1000, maxUses: 100, start: 45, expires: -45, active: true, approval: 'APPROVED', services: ['C1', 'C2', 'C3'], assigned: 'fahad', created: 'sara', note: 'كوبون فريق المبيعات للعملاء المحولين من المعارض.' },
    { key: 'RAMADAN20', code: 'RAMADAN20', owner: 'PC', value: 20, max: 1500, maxUses: 40, start: 130, expires: 85, active: true, approval: 'APPROVED', assigned: 'sara', created: 'sara' },
    { key: 'VIP40', code: 'VIP40', owner: 'PC', value: 40, max: 2000, maxUses: 10, start: 0, expires: -30, active: false, approval: 'PENDING', services: ['C2'], assigned: 'fahad', created: 'sara', note: 'خصم لكبار العملاء — يحتاج موافقة المالك (أكثر من 30%).' },
    { key: 'BLACKFRIDAY50', code: 'BLACKFRIDAY50', owner: 'PC', value: 50, maxUses: null, start: 5, expires: -60, active: false, approval: 'REJECTED', reject: 'نسبة الخصم مرتفعة جداً وبدون حد أقصى للاستخدام، يرجى تخفيضها إلى 30% وتحديد عدد الاستخدامات.', created: 'fahad', assigned: 'fahad' },
  ];
  const coupon: Record<string, { id: string; code: string; value: number; type: string; max?: number }> = {};
  for (const c of couponDefs) {
    const id = vid(`coupon:${c.key}`);
    const tm = (k?: string) => (k === 'sara' ? sara.id : k === 'fahad' ? fahad.id : null);
    const data = {
      providerId: c.owner === 'P' ? provider.id : company.id, discountType: c.type ?? 'percentage', discountValue: c.value,
      minimumAmount: c.minimum ?? null, maxDiscount: c.max ?? null, maxUsesPerUser: 1, startAt: daysAgo(c.start), active: c.active,
      expiresAt: c.expires === null ? null : daysAgo(c.expires), maxUses: c.maxUses ?? null, excludedServiceIds: [],
      internalNote: c.note ?? null, assignedToTeamMemberId: tm(c.assigned), createdByTeamMemberId: tm(c.created),
      approvalStatus: c.approval, rejectionReason: c.reject ?? null, createdAt: daysAgo(c.start + 1),
    };
    await prisma.coupon.upsert({ where: { code: c.code }, create: { id, code: c.code, ...data }, update: data });
    const row = await prisma.coupon.findUniqueOrThrow({ where: { code: c.code } });
    coupon[c.key] = { id: row.id, code: c.code, value: c.value, type: c.type ?? 'percentage', max: c.max };
    if (c.services?.length) {
      await prisma.couponService.createMany({ data: c.services.map(s => ({ couponId: row.id, serviceId: svc[s].id })), skipDuplicates: true });
      tally('CouponService', c.services.length);
    }
    tally('Coupon');
  }

  // ─── special offers ─────────────────────────────────────────────────────
  type OfferDef = { key: string; owner: 'P' | 'PC'; type: 'BUNDLE' | 'DIRECT_DISCOUNT'; name: string; primary?: string; beneficiary?: string; target?: string; value: number; validity?: number; start: number; expires: number | null; badge: string; active: boolean; approval: 'APPROVED' | 'PENDING' | 'REJECTED'; reject?: string; assigned?: string; created?: string };
  const offerDefs: OfferDef[] = [
    { key: 'O-P-BUNDLE', owner: 'P', type: 'BUNDLE', name: 'باقة المتجر + تصميم التطبيق', primary: 'P1', beneficiary: 'P2', value: 20, validity: 30, start: 60, expires: -30, badge: 'وفّر 20% على تصميم التطبيق', active: true, approval: 'APPROVED' },
    { key: 'O-P-DIRECT-EXP', owner: 'P', type: 'DIRECT_DISCOUNT', name: 'خصم تصميم الواجهات', target: 'P2', value: 15, start: 90, expires: 45, badge: 'خصم 15%', active: true, approval: 'APPROVED' },
    { key: 'O-C-DIRECT', owner: 'PC', type: 'DIRECT_DISCOUNT', name: 'خصم الهوية البصرية للشركات الناشئة', target: 'C1', value: 20, start: 50, expires: -40, badge: 'خصم 20% لفترة محدودة', active: true, approval: 'APPROVED', assigned: 'sara', created: 'sara' },
    { key: 'O-C-BUNDLE-PENDING', owner: 'PC', type: 'BUNDLE', name: 'باقة الهوية + حملة SEO', primary: 'C1', beneficiary: 'C3', value: 35, validity: 45, start: 0, expires: -60, badge: 'وفّر 35% على حملة SEO', active: false, approval: 'PENDING', assigned: 'fahad', created: 'fahad' },
    { key: 'O-C-DIRECT-REJ', owner: 'PC', type: 'DIRECT_DISCOUNT', name: 'خصم تطبيقات الجوال', target: 'C2', value: 45, start: 7, expires: -20, badge: 'خصم 45%', active: false, approval: 'REJECTED', reject: 'الخصم يتجاوز هامش الربح المسموح لمشاريع التطبيقات.', created: 'fahad', assigned: 'fahad' },
    { key: 'O-C-DIRECT-EXP', owner: 'PC', type: 'DIRECT_DISCOUNT', name: 'عرض المواقع التعريفية', target: 'C4', value: 15, start: 100, expires: 55, badge: 'خصم 15%', active: true, approval: 'APPROVED', assigned: 'sara', created: 'sara' },
  ];
  const offer: Record<string, { id: string; value: number }> = {};
  for (const o of offerDefs) {
    const id = vid(`offer:${o.key}`);
    const tm = (k?: string) => (k === 'sara' ? sara.id : k === 'fahad' ? fahad.id : null);
    await up(prisma.specialOffer, id, {
      providerId: o.owner === 'P' ? provider.id : company.id, type: o.type, name: o.name,
      primaryServiceId: o.primary ? svc[o.primary].id : null, beneficiaryServiceId: o.beneficiary ? svc[o.beneficiary].id : null,
      targetServiceId: o.target ? svc[o.target].id : null, discountValue: o.value, validityDays: o.validity ?? null,
      startAt: daysAgo(o.start), expiresAt: o.expires === null ? null : daysAgo(o.expires), badgeText: o.badge,
      customerMessage: o.type === 'BUNDLE' ? 'اطلب الخدمة الأساسية واحصل على خصم تلقائي على الخدمة المرتبطة خلال فترة العرض.' : 'يطبق الخصم تلقائياً عند الطلب.',
      internalNote: o.approval === 'PENDING' ? 'بانتظار موافقة مالك الحساب.' : null, active: o.active,
      assignedToTeamMemberId: tm(o.assigned), createdByTeamMemberId: tm(o.created), approvalStatus: o.approval, rejectionReason: o.reject ?? null,
      createdAt: daysAgo(o.start + 1),
    });
    offer[o.key] = { id, value: o.value };
    tally('SpecialOffer');
  }

  // ─── orders + redemptions ───────────────────────────────────────────────
  const customer = (k: string) => (k === 'C' ? { id: client.id } : { id: ex[k].id });
  type OrderDef = { key: string; who: string; items: string[]; days: number; status?: OrderStatus; coupon?: string; offers?: { key: string; on: string }[] };
  const orderDefs: OrderDef[] = [
    // provider (individual) — PROVSTART15 (active, real usage)
    { key: 'o1', who: 'nora', items: ['P1'], days: 3, status: OrderStatus.PAID, coupon: 'PROVSTART15' },
    { key: 'o2', who: 'khalid', items: ['P2'], days: 9, coupon: 'PROVSTART15' },
    { key: 'o3', who: 'reem', items: ['P1'], days: 16, coupon: 'PROVSTART15' },
    { key: 'o4', who: 'C', items: ['P2'], days: 24, coupon: 'PROVSTART15' },
    { key: 'o5', who: 'majed', items: ['P1'], days: 38, coupon: 'PROVSTART15' },
    // SUMMER25 (expired)
    { key: 'o7', who: 'lama', items: ['P1'], days: 70, coupon: 'SUMMER25' },
    { key: 'o8', who: 'turki', items: ['P2'], days: 55, coupon: 'SUMMER25' },
    // bundle P1 -> P2
    { key: 'o9', who: 'reem', items: ['P2'], days: 10, offers: [{ key: 'O-P-BUNDLE', on: 'P2' }] },
    { key: 'o10', who: 'khalid', items: ['P1'], days: 30 },
    { key: 'o11', who: 'khalid', items: ['P2'], days: 22, offers: [{ key: 'O-P-BUNDLE', on: 'P2' }] },
    { key: 'o12', who: 'turki', items: ['P1', 'P2'], days: 5, offers: [{ key: 'O-P-BUNDLE', on: 'P2' }] },
    // expired direct on P2
    { key: 'o13', who: 'lama', items: ['P2'], days: 50, offers: [{ key: 'O-P-DIRECT-EXP', on: 'P2' }] },
    // company — TEAM15
    { key: 'p1', who: 'nora', items: ['C1'], days: 2, status: OrderStatus.PAID, coupon: 'TEAM15' },
    { key: 'p2', who: 'C', items: ['C1'], days: 6, coupon: 'TEAM15' },
    { key: 'p3', who: 'lama', items: ['C2'], days: 13, coupon: 'TEAM15' },
    { key: 'p4', who: 'majed', items: ['C3'], days: 19, coupon: 'TEAM15' },
    { key: 'p5', who: 'khalid', items: ['C1'], days: 27, coupon: 'TEAM15', offers: [{ key: 'O-C-DIRECT', on: 'C1' }] },
    { key: 'p6', who: 'reem', items: ['C3'], days: 33, coupon: 'TEAM15' },
    // RAMADAN20 (expired)
    { key: 'q1', who: 'turki', items: ['C1'], days: 120, coupon: 'RAMADAN20' },
    { key: 'q2', who: 'lama', items: ['C3'], days: 100, coupon: 'RAMADAN20' },
    { key: 'q3', who: 'nora', items: ['C2'], days: 95, coupon: 'RAMADAN20' },
    // direct offer on C1 (active)
    { key: 'r1', who: 'turki', items: ['C1'], days: 1, status: OrderStatus.PAID, offers: [{ key: 'O-C-DIRECT', on: 'C1' }] },
    { key: 'r2', who: 'majed', items: ['C1'], days: 8, offers: [{ key: 'O-C-DIRECT', on: 'C1' }] },
    { key: 'r3', who: 'reem', items: ['C1'], days: 21, offers: [{ key: 'O-C-DIRECT', on: 'C1' }] },
    { key: 'r4', who: 'khalid', items: ['C1'], days: 44, offers: [{ key: 'O-C-DIRECT', on: 'C1' }] },
    // expired direct on C4
    { key: 's1', who: 'C', items: ['C4'], days: 75, offers: [{ key: 'O-C-DIRECT-EXP', on: 'C4' }] },
    { key: 's2', who: 'reem', items: ['C4'], days: 65, offers: [{ key: 'O-C-DIRECT-EXP', on: 'C4' }] },
    // client's own history (marketplace origin of PR1/PR7 + pending/cancelled)
    { key: 'c-pr1', who: 'C', items: ['P1'], days: 12 },
    { key: 'c-pr7', who: 'C', items: ['C2'], days: 20 },
    { key: 'c-pending', who: 'C', items: ['C3'], days: 0, status: OrderStatus.PENDING_PAYMENT },
    { key: 'c-cancel', who: 'C', items: ['P2'], days: 18, status: OrderStatus.CANCELLED },
  ];
  const couponUses: Record<string, number> = {};
  const orderNumbers: Record<string, string> = {};
  for (const [i, o] of orderDefs.entries()) {
    const id = vid(`order:${o.key}`);
    const orderNumber = `WS-VA-${String(i + 1).padStart(5, '0')}`;
    orderNumbers[o.key] = orderNumber;
    const at = daysAgo(o.days, 2 + (i % 7));
    const subtotal = o.items.reduce((a, k) => a + svc[k].amount, 0);
    let couponAmount = 0;
    const c = o.coupon ? coupon[o.coupon] : null;
    if (c) {
      const raw = c.type === 'fixed' ? c.value : (subtotal * c.value) / 100;
      couponAmount = round2(Math.min(raw, c.max ?? Infinity, subtotal));
    }
    const offerAmounts = (o.offers ?? []).map(of => ({ ...of, amount: round2((svc[of.on].amount * offer[of.key].value) / 100) }));
    const discount = round2(couponAmount + offerAmounts.reduce((a, x) => a + x.amount, 0));
    const status = o.status ?? OrderStatus.COMPLETED;
    await up(prisma.order, id, {
      orderNumber, userId: customer(o.who).id, status, subtotal, discount, total: round2(subtotal - discount),
      couponId: c?.id ?? null, couponCode: c?.code ?? null, couponDiscountType: c?.type ?? null, couponDiscountValue: c?.value ?? null, createdAt: at,
    });
    for (const [j, k] of o.items.entries()) {
      const card = providerCard(svc[k].owner);
      await up(prisma.orderItem, vid(`order:${o.key}:item:${j}`), {
        orderId: id, serviceId: svc[k].id, modelId: svc[k].id, title: svc[k].title, providerId: card.id, providerName: card.name,
        initials: card.initials, isVerified: true, packageId: 'basic', packageName: 'الباقة الأساسية', price: svc[k].amount, deliveryDays: svc[k].days, aiScore: svc[k].ai,
      });
      tally('OrderItem');
    }
    if (c && status !== OrderStatus.PENDING_PAYMENT) {
      await prisma.couponRedemption.upsert({
        where: { orderId: id },
        create: { id: vid(`cr:${o.key}`), couponId: c.id, userId: customer(o.who).id, orderId: id, amount: couponAmount, createdAt: at },
        update: { couponId: c.id, userId: customer(o.who).id, amount: couponAmount, createdAt: at },
      });
      couponUses[o.coupon!] = (couponUses[o.coupon!] ?? 0) + 1;
      tally('CouponRedemption');
    }
    for (const of of offerAmounts) {
      await prisma.specialOfferRedemption.upsert({
        where: { offerId_userId_orderId: { offerId: offer[of.key].id, userId: customer(o.who).id, orderId: id } },
        create: { id: vid(`sor:${o.key}:${of.key}`), offerId: offer[of.key].id, userId: customer(o.who).id, orderId: id, amount: of.amount, createdAt: at },
        update: { amount: of.amount, createdAt: at },
      });
      tally('SpecialOfferRedemption');
    }
    tally('Order');
  }
  for (const c of couponDefs) await prisma.coupon.update({ where: { id: coupon[c.key].id }, data: { usedCount: couponUses[c.key] ?? 0 } });
  const offerUses = await prisma.specialOfferRedemption.groupBy({ by: ['offerId'], _count: { _all: true }, where: { offerId: { in: Object.values(offer).map(o => o.id) } } });
  for (const g of offerUses) await prisma.specialOffer.update({ where: { id: g.offerId }, data: { usedCount: g._count._all } });

  // ─── wallet transactions ────────────────────────────────────────────────
  type Tx = { key: string; userId: string; type: string; amount: number; status?: string; method?: string; ref?: string; desc: string; days: number; currency?: string; meta?: Record<string, unknown> };
  const txs: Tx[] = [
    { key: 'c-dep1', userId: client.id, type: 'DEPOSIT', amount: 5000, method: 'MOYASAR_CARD', desc: 'شحن المحفظة عبر بطاقة مدى', days: 100 },
    { key: 'c-dep2', userId: client.id, type: 'DEPOSIT', amount: 3000, method: 'PAYPAL', desc: 'شحن المحفظة عبر PayPal', days: 62 },
    { key: 'c-dep3', userId: client.id, type: 'DEPOSIT', amount: 8000, method: 'MOYASAR_APPLEPAY', desc: 'شحن المحفظة عبر Apple Pay', days: 25 },
    { key: 'c-dep-fail', userId: client.id, type: 'DEPOSIT', amount: 500, status: 'FAILED', method: 'MOYASAR_CARD', desc: 'فشل شحن المحفظة — رفض البطاقة', days: 7 },
    { key: 'c-dep-pend', userId: client.id, type: 'DEPOSIT', amount: 1500, status: 'PENDING', method: 'BANK_TRANSFER', desc: 'تحويل بنكي قيد التحقق', days: 1 },
    ...clientWalletEscrowRefs.map(e => ({ key: `c-esc-${e.key}`, userId: client.id, type: 'ESCROW_LOCK', amount: e.amount, method: 'WALLET', ref: e.ref, desc: `حجز ضمان المشروع: ${e.title}`, days: (NOW.getTime() - e.at.getTime()) / DAY, meta: { projectId: projectIds[e.key] } })),
    { key: 'c-order-o4', userId: client.id, type: 'ORDER_PAYMENT', amount: -round2(950 - 142.5), method: 'WALLET', desc: `دفع الطلب ${orderNumbers.o4}`, days: 24 },
    { key: 'c-order-p2', userId: client.id, type: 'ORDER_PAYMENT', amount: -(3200 - 480), method: 'WALLET', desc: `دفع الطلب ${orderNumbers.p2}`, days: 6 },
    { key: 'c-refund-pr9', userId: client.id, type: 'REFUND', amount: 1100, method: 'WALLET', desc: 'استرداد جزئي بعد حل النزاع — موقع تعريفي لمكتب محاماة', days: 35 },
    { key: 'c-refund-cancel', userId: client.id, type: 'REFUND', amount: 950, method: 'WALLET', desc: `استرداد الطلب الملغي ${orderNumbers['c-cancel']}`, days: 17 },
    // provider (individual)
    { key: 'p-rel-pr2', userId: provider.id, type: 'ESCROW_RELEASE', amount: 950, method: 'WALLET', desc: 'إفراج ضمان — تصميم تطبيق حجز مواعيد', days: 30 },
    { key: 'p-rel-pr1', userId: provider.id, type: 'ESCROW_RELEASE', amount: 540, method: 'WALLET', desc: 'إفراج دفعة المرحلة الأولى — متجر العطور', days: 8 },
    { key: 'p-rel-pr5', userId: provider.id, type: 'ESCROW_RELEASE', amount: 1200, method: 'WALLET', desc: 'إفراج دفعات المرحلتين 1 و2 — تحسين الأداء', days: 4 },
    { key: 'p-wd-done', userId: provider.id, type: 'WITHDRAWAL', amount: -800, method: 'paypal', ref: 'VA-WD-P-COMPLETED', desc: 'سحب رصيد إلى PayPal', days: 20 },
    // company
    { key: 'pc-rel-pr6', userId: company.id, type: 'ESCROW_RELEASE', amount: 3200, method: 'WALLET', desc: 'إفراج ضمان — هوية بصرية لمقهى مختص', days: 50 },
    { key: 'pc-rel-pr9', userId: company.id, type: 'ESCROW_RELEASE', amount: 1100, method: 'WALLET', desc: 'إفراج جزئي بعد حل النزاع — مكتب محاماة', days: 35 },
    { key: 'pc-rel-pr7', userId: company.id, type: 'ESCROW_RELEASE', amount: 2550, method: 'WALLET', desc: 'إفراج المرحلة الأولى — تطبيق التوصيل', days: 9 },
    { key: 'pc-wd-done', userId: company.id, type: 'WITHDRAWAL', amount: -2000, method: 'bank_transfer', ref: 'VA-WD-PC-COMPLETED', desc: 'سحب رصيد إلى الحساب البنكي', days: 28 },
    { key: 'pc-wd-appr', userId: company.id, type: 'WITHDRAWAL', amount: -1000, method: 'bank_transfer', ref: 'VA-WD-PC-APPROVED', desc: 'اعتماد طلب السحب', days: 3 },
    // marketer
    { key: 'm-comm1', userId: marketer.id, type: 'COMMISSION', amount: 150, method: 'WALLET', desc: 'عمولة إحالة — أول مشروع مكتمل', days: 40 },
    { key: 'm-comm2', userId: marketer.id, type: 'COMMISSION', amount: 75, method: 'WALLET', desc: 'عمولة إحالة — طلب عميل جديد', days: 12 },
    { key: 'm-wd', userId: marketer.id, type: 'WITHDRAWAL', amount: -150, method: 'bank_transfer', desc: 'سحب العمولات', days: 30 },
  ];
  for (const t of txs) {
    const ref = t.ref ?? `VA-TX-${t.key.toUpperCase()}`;
    await up(prisma.walletTransaction, vid(`tx:${t.key}`), {
      userId: t.userId, type: t.type, amount: t.amount, currency: t.currency ?? 'USD', status: t.status ?? 'COMPLETED',
      paymentMethod: t.method ?? null, referenceId: ref, description: t.desc, metadata: t.meta ?? {}, createdAt: daysAgo(t.days),
    });
    tally('WalletTransaction');
  }

  // ─── withdrawals (+ payout attempts) ────────────────────────────────────
  const wdDefs = [
    { key: 'P-PENDING', userId: provider.id, amount: 600, method: 'bank_transfer', status: WithdrawalStatus.PENDING, days: 1 },
    { key: 'P-COMPLETED', userId: provider.id, amount: 800, method: 'paypal', status: WithdrawalStatus.COMPLETED, days: 21, paypal: 'provider.payouts@test.com', attempt: 'COMPLETED' },
    { key: 'P-REJECTED', userId: provider.id, amount: 4500, method: 'bank_transfer', status: WithdrawalStatus.REJECTED, days: 14, reject: 'المبلغ المطلوب يتجاوز الرصيد المتاح للسحب.' },
    { key: 'PC-COMPLETED', userId: company.id, amount: 2000, method: 'bank_transfer', status: WithdrawalStatus.COMPLETED, days: 29 },
    { key: 'PC-PROCESSING', userId: company.id, amount: 1500, method: 'paypal', status: WithdrawalStatus.PROCESSING, days: 5, paypal: 'finance@example-agency.sa', attempt: 'PROCESSING' },
    { key: 'PC-APPROVED', userId: company.id, amount: 1000, method: 'bank_transfer', status: WithdrawalStatus.APPROVED, days: 4 },
    { key: 'PC-PENDING', userId: company.id, amount: 700, method: 'bank_transfer', status: WithdrawalStatus.PENDING, days: 0.5 },
  ];
  const wdIds: Record<string, string> = {};
  for (const w of wdDefs) {
    const id = vid(`withdrawal:${w.key}`);
    wdIds[w.key] = id;
    const reviewed = w.status !== WithdrawalStatus.PENDING;
    const isBank = w.method === 'bank_transfer';
    await up(prisma.withdrawal, id, {
      userId: w.userId, amount: w.amount, currency: 'USD', method: w.method,
      accountName: isBank ? (w.userId === company.id ? 'وكالة الإبداع الرقمي' : `${provider.firstName} ${provider.lastName}`) : null,
      accountNumber: isBank ? '608010167519' : null, iban: isBank ? 'SA0380000000608010167519' : null, paypalEmail: w.paypal ?? null,
      status: w.status, reviewedById: reviewed ? admin.id : null, rejectionReason: w.reject ?? null,
      adminNote: reviewed ? (w.reject ? 'تم الرفض بعد مراجعة الرصيد.' : 'تمت المراجعة والتحقق من بيانات الحساب.') : null,
      referenceId: `VA-WD-${w.key}`, createdAt: daysAgo(w.days),
    });
    if (w.attempt) {
      await up(prisma.payoutAttempt, vid(`payout:${w.key}:1`), {
        withdrawalId: id, provider: 'PAYPAL', attemptNumber: 1, senderBatchId: `va-batch-${w.key.toLowerCase()}-1`,
        payoutBatchId: `VA${w.key.replace('-', '')}BATCH`, payoutItemId: w.attempt === 'COMPLETED' ? `VA${w.key.replace('-', '')}ITEM` : null,
        status: w.attempt, rawResponse: { batch_status: w.attempt === 'COMPLETED' ? 'SUCCESS' : 'PENDING' },
        completedAt: w.attempt === 'COMPLETED' ? daysAgo(w.days - 1) : null, createdAt: daysAgo(w.days - 0.5),
      });
      tally('PayoutAttempt');
    }
    tally('Withdrawal');
  }

  // ─── accreditation (specialties, samples, submissions, work samples) ────
  type PsDef = { key: string; profile: string; specialty: { id: string; nameAr: string }; status: SpecialtyVerificationStatus; score?: number; sub: string[] };
  const psDefs: PsDef[] = [
    { key: 'P-FE', profile: provider.providerProfile.id, specialty: sp.fe, status: SpecialtyVerificationStatus.APPROVED, score: 91, sub: ['React', 'Next.js'] },
    { key: 'P-UX', profile: provider.providerProfile.id, specialty: sp.ux, status: SpecialtyVerificationStatus.PENDING_AUDIT, sub: ['Figma'] },
    { key: 'P-BE', profile: provider.providerProfile.id, specialty: sp.be, status: SpecialtyVerificationStatus.REJECTED, score: 41, sub: ['Node.js'] },
    { key: 'C-BRAND', profile: company.providerProfile.id, specialty: sp.brand, status: SpecialtyVerificationStatus.APPROVED, score: 95, sub: ['Logo Design', 'Brand Guidelines'] },
    { key: 'C-MOB', profile: company.providerProfile.id, specialty: sp.mobile, status: SpecialtyVerificationStatus.UNDER_AI_REVIEW, score: 68, sub: ['Flutter'] },
    { key: 'C-SEO', profile: company.providerProfile.id, specialty: sp.seo, status: SpecialtyVerificationStatus.TEST_REQUIRED, score: 74, sub: ['Technical SEO'] },
  ];
  const psIds: Record<string, string> = {};
  for (const p of psDefs) {
    const approved = p.status === SpecialtyVerificationStatus.APPROVED;
    const data = {
      subSpecialties: p.sub, status: p.status, isActive: true, hasTakenAssessment: approved || p.status === SpecialtyVerificationStatus.REJECTED,
      latestScore: p.score ?? null, isPassed: approved, passedAt: approved ? daysAgo(90) : null, aiScore: p.score ?? null,
      feasibilityScore: p.score ? p.score - 2 : null, clarityScore: p.score ? p.score - 4 : null, ownershipCredibility: p.score ? p.score + 2 : null,
      quizScore: approved ? 85 : null, badgeGrantedAt: approved ? daysAgo(88) : null,
      aiFeedback: { summary: approved ? 'نماذج أعمال قوية وموثقة.' : 'تحتاج النماذج إلى إثباتات ملكية أوضح.', strengths: ['جودة تنفيذ عالية'], warnings: approved ? [] : ['إثبات الملكية غير كافٍ'], corrections: [] },
      legalSignedAt: daysAgo(95),
    };
    const row = await prisma.providerSpecialty.upsert({
      where: { providerProfileId_specialtyId: { providerProfileId: p.profile, specialtyId: p.specialty.id } },
      create: { id: vid(`ps:${p.key}`), providerProfileId: p.profile, specialtyId: p.specialty.id, ...data },
      update: data,
    });
    psIds[p.key] = row.id;
    tally('ProviderSpecialty');
  }
  const sampleDefs = [
    { key: 'AS-P-FE', ps: 'P-FE', profile: provider.providerProfile.id, title: 'متجر "عطور الشرق" — Next.js وStripe', status: AccreditationStatus.AI_VERIFIED, score: 92, quality: 'EXCELLENT', tech: ['Next.js', 'TypeScript', 'Stripe', 'Tailwind'], svcLink: 'P1', days: 90 },
    { key: 'AS-P-UX', ps: 'P-UX', profile: provider.providerProfile.id, title: 'تطبيق حجز مواعيد طبية — دراسة حالة UX', status: AccreditationStatus.PENDING_AI_AUDIT, tech: ['Figma', 'FigJam'], days: 2 },
    { key: 'AS-P-BE', ps: 'P-BE', profile: provider.providerProfile.id, title: 'واجهة برمجية لإدارة المخزون', status: AccreditationStatus.REJECTED, score: 41, quality: 'POOR', tech: ['Node.js', 'Express'], days: 30 },
    { key: 'AS-C-BRAND', ps: 'C-BRAND', profile: company.providerProfile.id, title: 'هوية مقهى "بن وهيل" المتكاملة', status: AccreditationStatus.AI_VERIFIED, score: 95, quality: 'EXCELLENT', tech: ['Illustrator', 'Photoshop'], svcLink: 'C1', days: 85 },
    { key: 'AS-C-MOB', ps: 'C-MOB', profile: company.providerProfile.id, title: 'تطبيق "وصلني" للتوصيل — Flutter', status: AccreditationStatus.MANUAL_REVIEW, score: 68, quality: 'ACCEPTABLE', tech: ['Flutter', 'Firebase', 'Google Maps'], days: 6 },
  ];
  const sampleIds: Record<string, string> = {};
  for (const s of sampleDefs) {
    const id = vid(`sample:${s.key}`);
    sampleIds[s.key] = id;
    const rejected = s.status === AccreditationStatus.REJECTED;
    await up(prisma.accreditationSample, id, {
      providerProfileId: s.profile, providerSpecialtyId: psIds[s.ps], title: s.title,
      description: `نموذج عمل مقدم للاعتماد: ${s.title}. يتضمن وصف المشكلة، الحل المنفذ، والنتائج المحققة للعميل مع لقطات شاشة وروابط حية.`,
      projectUrl: 'https://example.com/case-study', githubUrl: s.tech.includes('Node.js') || s.tech.includes('Next.js') ? 'https://github.com/example-dev/sample' : null,
      technologiesUsed: s.tech, attachments: [img(`va-${s.key}-1`, 1200, 800), img(`va-${s.key}-2`, 1200, 800), `https://files.example.com/accreditation/${s.key.toLowerCase()}.pdf`],
      status: s.status, aiScore: s.score ?? null, aiQualityRating: s.quality ?? null,
      aiFeedbackAr: s.score ? (rejected ? 'لم يتم العثور على إثبات كافٍ لملكية العمل، والكود المرفق غير مكتمل.' : 'عمل احترافي بجودة عالية وإثباتات ملكية واضحة.') : null,
      aiStrengths: s.score && !rejected ? ['جودة تنفيذ عالية', 'توثيق واضح', 'نتائج قابلة للقياس'] : [],
      aiRecommendations: rejected ? ['إرفاق عقد أو فاتورة تثبت الملكية', 'إرفاق رابط مستودع كامل'] : s.score ? ['إضافة مؤشرات أداء بعد الإطلاق'] : [],
      aiAuditedAt: s.score ? daysAgo(s.days - 1) : null, viewsCount: s.status === AccreditationStatus.AI_VERIFIED ? 340 : 0,
      rating: s.status === AccreditationStatus.AI_VERIFIED ? 4.8 : 0, reviewsCount: s.status === AccreditationStatus.AI_VERIFIED ? 12 : 0,
      offersGenerated: s.status === AccreditationStatus.AI_VERIFIED ? 9 : 0, offersAccepted: s.status === AccreditationStatus.AI_VERIFIED ? 5 : 0,
      createdAt: daysAgo(s.days),
    });
    if (s.svcLink) await prisma.serviceCatalog.update({ where: { id: svc[s.svcLink].id }, data: { accreditationSampleId: id } });
    tally('AccreditationSample');
  }
  const subDefs = [
    { key: 'SUB-P-FE', profile: provider.providerProfile.id, specialtyId: sp.fe.id, status: AccreditationStatus.AI_VERIFIED, score: 92, days: 90 },
    { key: 'SUB-P-UX', profile: provider.providerProfile.id, specialtyId: sp.ux.id, status: AccreditationStatus.PENDING_AI_AUDIT, days: 2 },
    { key: 'SUB-C-MOB', profile: company.providerProfile.id, specialtyId: sp.mobile.id, status: AccreditationStatus.MANUAL_REVIEW, score: 68, days: 6 },
  ];
  for (const s of subDefs) {
    const id = vid(`submission:${s.key}`);
    await up(prisma.accreditationSubmission, id, {
      providerProfileId: s.profile, providerSpecialtyId: s.specialtyId, status: s.status, overallAiScore: s.score ?? null,
      aiDecisionSummary: s.score ? (s.score >= 80 ? 'تم التحقق من أصالة الأعمال وجودتها.' : 'جودة مقبولة لكن تحتاج مراجعة بشرية لإثبات الملكية.') : null, createdAt: daysAgo(s.days),
    });
    const files = [
      { k: 'proof', fileType: 'PROOF_DOCUMENT', name: 'عقد-المشروع.pdf', url: `https://files.example.com/accreditation/${s.key.toLowerCase()}-contract.pdf` },
      { k: 'ws1', fileType: 'WORK_SAMPLE', name: 'screenshot-1.png', url: img(`va-${s.key}-ws1`, 1200, 800) },
      { k: 'ws2', fileType: 'WORK_SAMPLE', name: 'screenshot-2.png', url: img(`va-${s.key}-ws2`, 1200, 800) },
    ];
    for (const f of files) {
      await up(prisma.accreditationProofFile, vid(`submission:${s.key}:${f.k}`), { accreditationSubmissionId: id, fileType: f.fileType, fileUrl: f.url, fileName: f.name, fileSize: 845_000, createdAt: daysAgo(s.days) });
      tally('AccreditationProofFile');
    }
    if (s.score) {
      await up(prisma.aiAccreditationAuditLog, vid(`submission:${s.key}:log`), { accreditationSubmissionId: id, promptTokensUsed: 2140, completionTokensUsed: 610, rawAiResponse: { score: s.score, verdict: s.status }, evaluatedAt: daysAgo(s.days - 0.5) });
      tally('AiAccreditationAuditLog');
    }
    tally('AccreditationSubmission');
  }
  for (const w of [{ key: 'P-FE', title: 'متجر عطور الشرق', tech: ['Next.js', 'Stripe'] }, { key: 'C-BRAND', title: 'هوية بن وهيل', tech: ['Illustrator'] }]) {
    const wsId = vid(`worksample:${w.key}`);
    await up(prisma.workSample, wsId, { providerSpecialtyId: psIds[w.key], title: w.title, description: `نموذج عمل موثق: ${w.title}`, technologies: w.tech, publicSampleUrl: img(`va-ws-${w.key}`, 1200, 800), mimeType: 'image/jpeg', fileBytes: 512_000 });
    await up(prisma.proofAttachment, vid(`worksample:${w.key}:proof`), { workSampleId: wsId, fileName: 'فاتورة-المشروع.pdf', fileUrl: `https://files.example.com/proofs/${w.key.toLowerCase()}.pdf`, mimeType: 'application/pdf', fileBytes: 230_000 });
    tally('WorkSample'); tally('ProofAttachment');
  }

  // ─── gamification ───────────────────────────────────────────────────────
  for (const g of [{ u: provider.id, points: 340, done: 1, rating: 4.8, lvl: 4, comm: 13.5 }, { u: company.id, points: 720, done: 2, rating: 4.7, lvl: 6, comm: 12.5 }]) {
    await prisma.providerGamification.upsert({
      where: { providerId: g.u },
      create: { providerId: g.u, points: g.points, completedProjects: g.done, avgRating: g.rating, currentLevelIndex: g.lvl, currentCommission: g.comm },
      update: { points: g.points, completedProjects: g.done, avgRating: g.rating, currentLevelIndex: g.lvl, currentCommission: g.comm },
    });
    tally('ProviderGamification');
  }
  const pts = [
    { key: 'p1', u: provider.id, amount: 20, reason: 'PROJECT_COMPLETED', desc: 'إكمال مشروع بنجاح — تصميم تطبيق حجز مواعيد', days: 30 },
    { key: 'p2', u: provider.id, amount: 10, reason: 'FIVE_STAR_REVIEW', desc: 'تقييم 5 نجوم من العميل', days: 30 },
    { key: 'p3', u: provider.id, amount: 15, reason: 'EARLY_DELIVERY', desc: 'تسليم مبكر للمرحلة الأولى — متجر العطور', days: 8 },
    { key: 'p4', u: provider.id, amount: -25, reason: 'LATE_DELIVERY', desc: 'تأخير تسليم المرحلة الثانية — لوحة المخزون', days: 5 },
    { key: 'c1', u: company.id, amount: 20, reason: 'PROJECT_COMPLETED', desc: 'إكمال مشروع بنجاح — هوية المقهى', days: 50 },
    { key: 'c2', u: company.id, amount: 15, reason: 'EARLY_DELIVERY', desc: 'تسليم مبكر — تطبيق التوصيل', days: 9 },
  ];
  for (const p of pts) {
    await up(prisma.pointTransaction, vid(`points:${p.key}`), { providerId: p.u, amount: p.amount, reason: p.reason, description: p.desc, createdAt: daysAgo(p.days) });
    tally('PointTransaction');
  }

  // ─── favorites / saved ──────────────────────────────────────────────────
  for (const [u, s] of [[client.id, 'C1'], [client.id, 'P1'], [client.id, 'C3'], [ex.nora.id, 'P2']] as const) {
    await prisma.marketplaceFavorite.upsert({ where: { userId_serviceId: { userId: u, serviceId: svc[s].id } }, create: { userId: u, serviceId: svc[s].id }, update: {} });
    tally('MarketplaceFavorite');
  }
  for (const pk of ['PR12', 'PR13', 'PR14']) {
    await prisma.savedProject.upsert({ where: { providerId_projectId: { providerId: provider.id, projectId: projectIds[pk] } }, create: { providerId: provider.id, projectId: projectIds[pk] }, update: {} });
    tally('SavedProject');
  }

  // ─── marketer: referrals, commissions, channels ─────────────────────────
  const aff = marketer.affiliateProfile;
  const refDefs = [
    { key: 'nora', status: 'CONVERTED', channel: 'TIKTOK', days: 140 },
    { key: 'khalid', status: 'CONVERTED', channel: 'X_TWITTER', days: 120 },
    { key: 'reem', status: 'QUALIFIED', channel: 'INSTAGRAM', days: 60 },
    { key: 'majed', status: 'PENDING', channel: 'LINKEDIN', days: 10 },
    { key: 'turki', status: 'PENDING', channel: 'TIKTOK', days: 4 },
  ] as const;
  const refIds: Record<string, string> = {};
  for (const r of refDefs) {
    const existing = await prisma.referral.findUnique({ where: { referredUserId: ex[r.key].id } });
    const id = existing?.id ?? vid(`referral:${r.key}`);
    await up(prisma.referral, id, { affiliateId: aff.id, referredUserId: ex[r.key].id, status: r.status, sourceChannel: r.channel, createdAt: daysAgo(r.days) });
    refIds[r.key] = id;
    tally('Referral');
  }
  const commDefs = [
    { key: 'cm1', ref: 'nora', type: 'NEW_CLIENT_REQUEST', amount: 75, status: 'PAID', days: 130 },
    { key: 'cm2', ref: 'nora', type: 'FIRST_PROJECT_COMPLETED', amount: 150, status: 'PAID', days: 100 },
    { key: 'cm3', ref: 'khalid', type: 'NEW_CLIENT_REQUEST', amount: 75, status: 'APPROVED', days: 90 },
    { key: 'cm4', ref: 'khalid', type: 'FIRST_PROJECT_COMPLETED', amount: 210, status: 'APPROVED', days: 20 },
    { key: 'cm5', ref: 'reem', type: 'NEW_CLIENT_REQUEST', amount: 75, status: 'PENDING', days: 12 },
    { key: 'cm6', ref: null, type: 'SUBSCRIPTION', amount: 49, status: 'PENDING', days: 3 },
  ] as const;
  for (const c of commDefs) {
    await up(prisma.commissionLog, vid(`commission:${c.key}`), { affiliateId: aff.id, referralId: c.ref ? refIds[c.ref] : null, type: c.type, amount: c.amount, currency: 'USD', status: c.status, createdAt: daysAgo(c.days) });
    tally('CommissionLog');
  }
  const metricDefs = [
    { channel: 'TIKTOK', visitors: 4820, clients: 38 },
    { channel: 'X_TWITTER', visitors: 3150, clients: 27 },
    { channel: 'INSTAGRAM', visitors: 2640, clients: 19 },
    { channel: 'LINKEDIN', visitors: 980, clients: 11 },
    { channel: 'OTHER', visitors: 420, clients: 3 },
  ] as const;
  for (const m of metricDefs) {
    const data = { visitors: m.visitors, clients: m.clients, conversionPercentage: round2((m.clients / m.visitors) * 100) };
    await prisma.affiliateChannelMetric.upsert({ where: { affiliateId_channel: { affiliateId: aff.id, channel: m.channel } }, create: { affiliateId: aff.id, channel: m.channel, ...data }, update: data });
    tally('AffiliateChannelMetric');
  }
  for (const h of [{ k: 'tt', platform: 'TIKTOK', handle: '@wasit.tech', url: 'https://www.tiktok.com/@wasit.tech' }, { k: 'x', platform: 'TWITTER', handle: '@wasit_tech', url: 'https://x.com/wasit_tech' }, { k: 'ig', platform: 'INSTAGRAM', handle: '@wasit.tech', url: 'https://instagram.com/wasit.tech' }]) {
    await up(prisma.affiliateChannelHandle, vid(`handle:${h.k}`), { affiliateProfileId: aff.id, platform: h.platform, handle: h.handle, url: h.url, createdAt: daysAgo(150) });
    tally('AffiliateChannelHandle');
  }
  for (const l of [{ k: 'l1', name: 'حملة تيك توك سبتمبر', utm: 'tiktok', slug: 'tt-sep' }, { k: 'l2', name: 'نشرة لينكدإن', utm: 'linkedin', slug: 'li-news' }]) {
    await up(prisma.referralCustomLink, vid(`link:${l.k}`), { affiliateId: aff.id, channelName: l.name, utmSource: l.utm, customSlug: l.slug, createdAt: daysAgo(30) });
    tally('ReferralCustomLink');
  }
  for (const r of [
    { k: 'pcr1', num: 'VA-PCR-0001', field: 'IBAN', label: 'رقم الآيبان', cur: 'SA0380000000608010167519', req: 'SA4420000001234567891234', status: 'PENDING_HUMAN_APPROVAL', ai: 'البنك المستهدف مطابق لاسم صاحب الحساب.', conf: 88, days: 2 },
    { k: 'pcr2', num: 'VA-PCR-0002', field: 'PHONE_NUMBER', label: 'رقم الجوال', cur: '0500000004', req: '0555555004', status: 'APPROVED_AND_APPLIED', ai: 'تم التحقق عبر OTP.', conf: 97, days: 25 },
  ] as const) {
    const data = { affiliateProfileId: aff.id, fieldType: r.field, fieldLabel: r.label, currentValue: r.cur, requestedValue: r.req, status: r.status, aiRecommendation: r.ai, aiConfidenceScore: r.conf, reviewedBy: r.status === 'APPROVED_AND_APPLIED' ? admin.id : null, appliedAt: r.status === 'APPROVED_AND_APPLIED' ? daysAgo(r.days - 1) : null, createdAt: daysAgo(r.days) };
    await prisma.profileChangeRequest.upsert({ where: { requestNumber: r.num }, create: { id: vid(`pcr:${r.k}`), requestNumber: r.num, ...data }, update: data });
    tally('ProfileChangeRequest');
  }

  // ─── notifications ──────────────────────────────────────────────────────
  const C = NotificationCategory;
  const notifDefs: { key: string; userId: string; title: string; msg: string; type: string; cat: NotificationCategory; url?: string; read?: boolean; hours: number }[] = [
    { key: 'c1', userId: client.id, title: 'تسليم جديد بانتظار مراجعتك', msg: 'قام مقدم الخدمة بتسليم المرحلة الثانية من مشروع "تطوير متجر إلكتروني لعلامة عطور فاخرة".', type: 'STAGE_DELIVERY', cat: C.PROJECTS, url: `/client/projects/${projectIds.PR1}`, hours: 5 },
    { key: 'c2', userId: client.id, title: 'عرض جديد على طلبك', msg: 'وصلك عرضان جديدان على طلب "صفحة هبوط لإطلاق تطبيق لياقة بدنية".', type: 'NEW_PROPOSAL', cat: C.OFFERS, url: `/client/my-requests/${projectIds.PR4}`, hours: 20 },
    { key: 'c3', userId: client.id, title: 'تم استرداد مبلغ إلى محفظتك', msg: 'تمت إضافة 1,100$ إلى محفظتك بعد حل النزاع.', type: 'REFUND', cat: C.FINANCIAL, read: true, hours: 35 * 24 },
    { key: 'c4', userId: client.id, title: 'تحليل ذكي لعروض طلبك', msg: 'أنهى وسيط AI مقارنة العروض المقدمة وأوصى بالعرض الأنسب من حيث السعر والجودة.', type: 'AI_INSIGHT', cat: C.AI, hours: 30 },
    { key: 'c5', userId: client.id, title: 'تحديث على النزاع', msg: 'تم استلام نزاعك على مشروع "لوحة تحكم لإدارة مخزون المستودعات" وسيتم مراجعته خلال 48 ساعة.', type: 'DISPUTE', cat: C.PROJECTS, read: true, hours: 72 },
    { key: 'c6', userId: client.id, title: 'العقد بانتظار توقيعك', msg: 'وافقت وكالة الإبداع الرقمي على عرض "تصميم هوية تطبيق مالي ناشئ"، يرجى توقيع العقد.', type: 'CONTRACT', cat: C.PROJECTS, hours: 40 },
    { key: 'p1', userId: provider.id, title: 'تم قبول عرضك', msg: 'قبل العميل عرضك على مشروع "تحسين سرعة وأداء موقع شركة عقارية".', type: 'PROPOSAL_ACCEPTED', cat: C.OFFERS, read: true, hours: 15 * 24 },
    { key: 'p2', userId: provider.id, title: 'تم إفراج دفعة', msg: 'تم إفراج 540$ من الضمان بعد اعتماد المرحلة الأولى.', type: 'ESCROW_RELEASE', cat: C.FINANCIAL, hours: 8 * 24 },
    { key: 'p3', userId: provider.id, title: 'نزاع جديد على أحد مشاريعك', msg: 'فتح العميل نزاعاً على مشروع "لوحة تحكم لإدارة مخزون المستودعات".', type: 'DISPUTE', cat: C.PROJECTS, hours: 72 },
    { key: 'p4', userId: provider.id, title: 'مشروع مطابق لتخصصك', msg: 'يوجد مشروع جديد "إعادة تصميم متجر إلكترونيات" يطابق مهاراتك بنسبة 91%.', type: 'PROJECT_MATCH', cat: C.AI, hours: 10 },
    { key: 'p5', userId: provider.id, title: 'تم استخدام كوبونك', msg: 'استخدمت عميلة الكوبون PROVSTART15 على طلب جديد.', type: 'COUPON_REDEMPTION', cat: C.OFFERS, hours: 3 * 24 },
    { key: 'pc1', userId: company.id, title: 'كوبون بانتظار موافقتك', msg: 'أنشأت سارة الزهراني الكوبون VIP40 بخصم 40% ويحتاج موافقتك.', type: 'COUPON_APPROVAL', cat: C.OFFERS, hours: 6 },
    { key: 'pc2', userId: company.id, title: 'عرض خاص بانتظار موافقتك', msg: 'العرض "باقة الهوية + حملة SEO" بخصم 35% بانتظار الموافقة.', type: 'OFFER_APPROVAL', cat: C.OFFERS, hours: 7 },
    { key: 'pc3', userId: company.id, title: 'طلب تعديل على العقد', msg: 'طلب العميل إضافة ميزة المحفظة الإلكترونية إلى مشروع تطبيق التوصيل.', type: 'AMENDMENT', cat: C.PROJECTS, hours: 48 },
    { key: 'pc4', userId: company.id, title: 'تحويل السحب قيد المعالجة', msg: 'طلب السحب بقيمة 1,500$ قيد المعالجة عبر PayPal.', type: 'WITHDRAWAL', cat: C.FINANCIAL, read: true, hours: 5 * 24 },
    { key: 'pc5', userId: company.id, title: 'اقتراب سقف الإنفاق التسويقي', msg: 'تم استهلاك جزء كبير من سقف الخصومات الشهري لحملات التسويق.', type: 'SPEND_CAP', cat: C.AI, hours: 26 },
    { key: 'm1', userId: marketer.id, title: 'إحالة جديدة', msg: 'سجّل عميل جديد عبر رابط الإحالة الخاص بك من تيك توك.', type: 'NEW_REFERRAL', cat: C.ALL, hours: 4 * 24 },
    { key: 'm2', userId: marketer.id, title: 'تم اعتماد عمولة', msg: 'تم اعتماد عمولة بقيمة 210$ عن إكمال أول مشروع لعميل محال.', type: 'COMMISSION', cat: C.FINANCIAL, hours: 20 * 24 },
    { key: 'm3', userId: marketer.id, title: 'تحليل أداء القنوات', msg: 'قناة تيك توك تحقق أعلى معدل تحويل هذا الشهر.', type: 'AI_INSIGHT', cat: C.AI, read: true, hours: 60 },
    { key: 'a1', userId: admin.id, title: 'نزاع جديد يحتاج مراجعة', msg: 'تم فتح نزاع على مشروع "لوحة تحكم لإدارة مخزون المستودعات".', type: 'DISPUTE', cat: C.PROJECTS, hours: 72 },
    { key: 'a2', userId: admin.id, title: 'طلبات سحب بانتظار الاعتماد', msg: 'يوجد طلبا سحب جديدان بانتظار المراجعة.', type: 'WITHDRAWAL', cat: C.FINANCIAL, hours: 12 },
    { key: 'a3', userId: admin.id, title: 'نموذج اعتماد يحتاج مراجعة يدوية', msg: 'نموذج "تطبيق وصلني للتوصيل" بحاجة إلى مراجعة بشرية.', type: 'ACCREDITATION', cat: C.AI, hours: 6 * 24 },
  ];
  for (const n of notifDefs) {
    await up(prisma.notification, vid(`notif:${n.key}`), {
      userId: n.userId, title: n.title, message: n.msg, type: n.type, category: n.cat, actionUrl: n.url ?? null, actionText: n.url ? 'عرض التفاصيل' : null,
      isRead: n.read ?? false, metadata: {}, createdAt: new Date(NOW.getTime() - n.hours * 60 * 60 * 1000),
    });
    tally('Notification');
  }

  // ─── summary ────────────────────────────────────────────────────────────
  console.log('=== Visual-audit seed complete ===');
  console.table(Object.entries(counts).map(([entity, upserted]) => ({ entity, upserted })));
  const ids = {
    coupons: Object.fromEntries(Object.entries(coupon).map(([k, v]) => [k, v.id])),
    offers: Object.fromEntries(Object.entries(offer).map(([k, v]) => [k, v.id])),
    projects: projectIds,
    disputes: Object.fromEntries(disputeDefs.map(d => [d.key, vid(`dispute:${d.key}`)])),
    withdrawals: wdIds,
    accreditationSamples: sampleIds,
    services: Object.fromEntries(Object.entries(svc).map(([k, v]) => [k, v.id])),
  };
  console.log(JSON.stringify(ids, null, 2));
}

main()
  .catch(error => {
    console.error('Visual-audit seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
