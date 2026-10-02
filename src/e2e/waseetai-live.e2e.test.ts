import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// LIVE test: real WaseetAI (consumes a few calls) + a disposable local Postgres.
// Verifies that the business-model audit and proposal evaluation are driven by
// OUR records (category, stages, price / proposal text, milestones), change
// with the input, and never touch status/approval. Skipped unless BOTH
// TEST_DATABASE_URL (local e2e db, see assessment-flow.e2e.test.ts) and
// WASEETAI_LIVE=1 are set, and WASEET_AI_BEARER_TOKEN is available.

const TEST_DB = process.env.TEST_DATABASE_URL;
const enabled = process.env.WASEETAI_LIVE === '1' && !!TEST_DB && /@(localhost|127\.0\.0\.1)[:/]/.test(TEST_DB) && /e2e/i.test(TEST_DB);
const skip = enabled ? false : 'needs TEST_DATABASE_URL (local e2e db) + WASEETAI_LIVE=1';

let prisma: any; let auditService: any; let proposalService: any;
const ids: { providerId: string; design: string; software: string } = { providerId: '', design: '', software: '' };

before(async () => {
  if (!enabled) return;
  process.env.DATABASE_URL = TEST_DB!;
  ({ prisma } = await import('../config/db'));
  ({ aiAuditService: auditService } = await import('../services/ai-audit.service'));
  ({ aiProposalService: proposalService } = await import('../services/ai-proposal.service'));
  const category = await prisma.category.create({ data: { slug: `c-${Date.now()}`, nameAr: 'تصميم' } });
  ids.design = (await prisma.specialty.create({ data: { slug: `d-${Date.now()}`, categoryId: category.id, nameAr: 'التصميم والجرافيك' } })).id;
  ids.software = (await prisma.specialty.create({ data: { slug: `s-${Date.now()}`, categoryId: category.id, nameAr: 'البرمجة والتطوير' } })).id;
  ids.providerId = (await prisma.user.create({ data: { accountType: 'PROVIDER_INDIVIDUAL', firstName: 'مزود', lastName: 'اختبار', email: `live-${Date.now()}@example.test`, activeRole: 'PROVIDER' } })).id;
});
after(async () => { if (enabled) await prisma?.$disconnect(); });

const mkModel = (specialtyId: string | null, title: string, description: string, amount: number) =>
  prisma.serviceCatalog.create({
    data: {
      providerId: ids.providerId, title, description, specialtyId, totalAmount: amount, totalDays: 5, status: 'PENDING_APPROVAL',
      stages: { create: [
        { stepOrder: 1, title: 'مسودات الشعار', description: 'ثلاث أفكار أولية', deliveryDays: 2, percentage: 40, computedAmount: amount * 0.4 },
        { stepOrder: 2, title: 'التسليم النهائي', description: 'ملفات AI وPNG وPDF', deliveryDays: 3, percentage: 60, computedAmount: amount * 0.6 },
      ] },
    },
  });

test('live: business-model audit follows OUR data (category, content) and never changes status', { skip }, async () => {
  const good = await mkModel(ids.design, 'باقة تصميم شعار احترافي', 'تصميم شعار لعلامتك مع ثلاث مراجعات وتسليم ملفات AI وPNG وPDF خلال 5 أيام ودليل استخدام مختصر.', 120);
  const wrongCategory = await mkModel(ids.software, 'باقة تصميم شعار احترافي', 'تصميم شعار لعلامتك مع ثلاث مراجعات وتسليم ملفات AI وPNG وPDF خلال 5 أيام ودليل استخدام مختصر.', 120);
  const vague = await mkModel(ids.design, 'خدمة', 'شغل حلو', 5000);
  const noCategory = await mkModel(null, 'باقة بلا تصنيف', 'وصف طويل ومفصل لخدمة بلا تصنيف محدد في النظام.', 100);

  const a = await auditService.executeAuditSync(good.id);
  const b = await auditService.executeAuditSync(wrongCategory.id);
  const c = await auditService.executeAuditSync(vague.id);
  const d = await auditService.executeAuditSync(noCategory.id);

  assert.equal(a.outcome, 'audited'); assert.equal(b.outcome, 'audited'); assert.equal(c.outcome, 'audited');
  assert.deepEqual([d.outcome, d.reason], ['skipped', 'NO_CATEGORY']);
  console.log(`   scores: good=${a.score} wrongCategory=${b.score} vague=${c.score}; approved: ${a.isApproved}/${b.isApproved}/${c.isApproved}`);
  assert.ok(a.score > c.score, 'a well-described listing scores above a vague one');
  assert.ok(a.score > b.score || a.isApproved !== b.isApproved, 'the same text under the wrong category is judged differently');

  const rowGood = await prisma.serviceCatalog.findUnique({ where: { id: good.id } });
  assert.equal(rowGood.aiAuditScore, a.score);
  assert.equal(rowGood.aiAuditReport.source, 'WASEET_AI');
  assert.ok(rowGood.aiReviewSummary.length > 10);
  assert.equal(rowGood.aiClarityScore, null); assert.equal(rowGood.aiFeasibilityScore, null);
  for (const m of [good, wrongCategory, vague, noCategory]) {
    const row = await prisma.serviceCatalog.findUnique({ where: { id: m.id } });
    assert.equal(row.status, 'PENDING_APPROVAL', 'AI audit never changes approval status');
    assert.equal(row.approvedAt, null); assert.equal(row.auditRejectionReason, null);
  }
  const untouched = await prisma.serviceCatalog.findUnique({ where: { id: noCategory.id } });
  assert.equal(untouched.aiAuditScore, null, 'skipped model: nothing written');
});

test('live: proposal evaluation changes with the proposal content and uses our milestones', { skip }, async () => {
  const strong = await proposalService.evaluate({
    projectId: 'real-project-id', title: 'متجر إلكتروني كامل بـReact ولوحة تحكم',
    message: 'خبرة 7 سنوات، نفذت 14 متجرًا. أسبوع للتصميم، أسبوعان للتطوير، أسبوع للاختبار والتسليم مع ضمان 30 يومًا وتقرير أسبوعي وتسليم الكود على GitHub.',
    totalPrice: 2500, deliveryDays: 28,
    milestones: [
      { stepOrder: 1, title: 'التصميم', description: 'نماذج الواجهات', days: 7, percentage: 30, amount: 750 },
      { stepOrder: 2, title: 'التطوير', description: 'بناء المتجر', days: 14, percentage: 50, amount: 1250 },
      { stepOrder: 3, title: 'التسليم', description: 'اختبار وتسليم', days: 7, percentage: 20, amount: 500 },
    ],
  });
  const weak = await proposalService.evaluate({ projectId: 'real-project-id', title: 'عرض', message: 'ممكن', totalPrice: 90000, deliveryDays: 1 });
  console.log(`   quality: strong=${strong.qualityScore}/${strong.qualityTag} weak=${weak.qualityScore}/${weak.qualityTag}`);
  assert.ok(strong.qualityScore > weak.qualityScore + 20);
  assert.ok(strong.summary.length > 20 && weak.summary.length > 20);
  assert.notEqual(strong.summary, weak.summary);
  assert.equal('priceTag' in strong, false, 'the price tag (not tied to the real budget) is never returned');
});
