import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_TEST_DEV_FALLBACK_QUESTIONS } from '../constants/setup-test-dev-fallback';

test('Round 2 QA Item 4: setup-test fallback bank options have balanced lengths so the correct option never stands out', () => {
  assert.equal(SETUP_TEST_DEV_FALLBACK_QUESTIONS.length, 15);
  for (const q of SETUP_TEST_DEV_FALLBACK_QUESTIONS) {
    const lens = q.options.map(o => o.text.length);
    const min = Math.min(...lens);
    const max = Math.max(...lens);
    assert.ok(min >= 30, `Q${q.id} shortest option too short (${min}): ${JSON.stringify(lens)}`);
    assert.ok(max - min <= 22, `Q${q.id} option length spread too wide (${max - min}): ${JSON.stringify(lens)}`);
  }
});

test('Round 2 QA Item 2, 3 & 7A: suggestSkills passes subSpecialties + availableSkills, enhanceBio rephrases bio, verifyIdentityDocument inspects image', async (t: TestContext) => {
  const aiCalls: Array<{ method: string; body: any }> = [];
  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        providerProfile: {
          findUnique: async () => ({
            headline: 'مطور Backend',
            industry: null,
            bio: 'خبرة في بناء الأنظمة الخلفية',
            mainSpecialty: 'web-dev',
            subSpecialties: [],
            skills: [{ name: 'Git' }],
          }),
        },
        category: { findFirst: async () => ({ nameAr: 'تطوير المواقع' }) },
        skill: {
          findMany: async () => [
            { name: 'C#' },
            { name: '.NET' },
            { name: 'ASP.NET' },
            { name: 'Entity Framework' },
            { name: 'SQL Server' },
            { name: 'REST API' },
            { name: 'HTML' },
            { name: 'Git' },
          ],
        },
      },
    },
  });
  t.mock.module('./ai/waseet-ai/waseet-ai.client', {
    namedExports: {
      waseetAiClient: {
        suggestSkills: async (body: any) => {
          aiCalls.push({ method: 'suggestSkills', body });
          return { suggestedSkills: ['C#', '.NET Core', 'ASP.NET Core', 'Entity Framework Core', 'SQL Server', 'RESTful APIs'] };
        },
        enhanceBio: async (body: any) => {
          aiCalls.push({ method: 'enhanceBio', body });
          return { suggestedBio: 'مطور .NET متخصص في لغة C# وبناء الواجهات البرمجية وقواعد البيانات بكفاءة عالية.' };
        },
        inspectIdentityDocument: async (body: any) => {
          aiCalls.push({ method: 'inspectIdentityDocument', body });
          return {
            status: 'NOT_ID_DOCUMENT',
            isIdentityDocument: false,
            detectedSide: 'UNKNOWN',
            sideMatchesExpected: false,
            readability: 'UNREADABLE',
            summaryAr: 'الصورة لا تبدو وثيقة هوية رسمية.',
            warningsAr: ['ارفع صورة البطاقة الرسمية.'],
            advisoryOnly: true,
          };
        },
      },
    },
  });

  const { providerProfileService } = await import(`./provider-profile.service.ts?qa2=${Date.now()}`);

  const skillsRes = await providerProfileService.suggestSkills('prov-1', {
    mainSpecialty: 'web-dev',
    subSpecialties: ['تطوير C# و.NET'],
  });
  assert.deepEqual(skillsRes.suggestedSkills, ['C#', '.NET', 'ASP.NET', 'Entity Framework', 'SQL Server', 'REST API']);
  assert.deepEqual(aiCalls[0]?.body.subSpecialties, ['تطوير C# و.NET']);
  assert.ok(Array.isArray(aiCalls[0]?.body.availableSkills) && aiCalls[0]!.body.availableSkills.includes('C#'));

  const bioRes = await providerProfileService.enhanceBio('prov-1', {
    bio: 'انا مبرمج دوت نت C# شغال في تطوير الانظمة وقواعد البيانات',
    subSpecialties: ['تطوير C# و.NET'],
  });
  assert.ok(bioRes.suggestedBio.includes('C#'));

  const kycRes = await providerProfileService.verifyIdentityDocument('prov-1', {
    side: 'FRONT',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  });
  assert.equal(kycRes.status, 'NOT_ID_DOCUMENT');
  assert.equal(aiCalls[2]?.body.imageMimeType, 'image/png');
});

test('Round 2 QA Item 7B: aiProposalService rejects blank title + message even when project exists in DB, and omits suggestedTotalPrice/suggestedMilestones', async (t: TestContext) => {
  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        project: {
          findUnique: async () => ({
            title: 'مشروع متجر إلكتروني',
            description: 'وصف كامل للمشروع في قاعدة البيانات',
            requirements: ['Node.js'],
            budgetMin: 1000,
            budgetMax: 2000,
            deliveryDays: 20,
          }),
        },
        clientRequest: { findUnique: async () => null },
      },
    },
  });
  t.mock.module('./ai/waseet-ai/waseet-ai.client', {
    namedExports: {
      waseetAiClient: {
        suggestProposal: async () => ({
          suggestedTitle: 'تنفيذ المتجر بأعلى جودة',
          suggestedMessage: 'سأقوم بتنفيذ المتجر وفق مراحل واضحة واختبار شامل.',
          suggestedTotalPrice: 1500,
          suggestedMilestones: [{ name: 'مرحلة 1', desc: 'وصف', days: 5, pct: 100 }],
          qualityScore: 88,
          qualityTag: 'Excellent',
          suggestedAdvantages: ['خبرة عملية'],
        }),
      },
    },
  });

  const { aiProposalService: svc } = await import(`./ai-proposal.service.ts?qa2=${Date.now()}`);

  await assert.rejects(
    () => svc.evaluateAndSuggestProposal('proj-1', '   ', '   '),
    (err: any) => err.statusCode === 400 && /عنوان أو نص العرض/.test(err.message)
  );

  const ok = await svc.evaluateAndSuggestProposal('proj-1', 'عرض تطوير المتجر', 'لدي خبرة واسعة في تطوير المتاجر الإلكترونية');
  assert.equal(ok.suggestedTitle, 'تنفيذ المتجر بأعلى جودة');
  assert.equal('suggestedTotalPrice' in ok, false);
  assert.equal('suggestedMilestones' in ok, false);
});

test('Round 2 QA Item 1: DeliveryReviewService extracts embedded HTTPS links from delivery note and supports visual inspection', async (t: TestContext) => {
  const calls: any[] = [];
  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        contract: {
          findFirst: async () => ({
            project: { id: 'proj-deliv', title: 'تطبيق', description: 'تطبيق جوال', requirements: ['شاشة الدخول'] },
            stages: [{
              title: 'المرحلة 1',
              description: 'تنفيذ الواجهات',
              deliveries: [{
                note: 'تم رفع الكود على https://github.com/org/repo ومرفق لقطة شاشة',
                submittedAt: new Date(),
                files: ['https://res.cloudinary.com/demo/image/upload/screen.png'],
              }],
            }],
          }),
        },
      },
    },
  });
  const { DeliveryReviewService } = await import(`./ai-features/delivery-review.service.ts?qa2=${Date.now()}`);
  const svc = new DeliveryReviewService(
    { generateJson: async () => { throw new Error('unused'); } },
    {
      enabled: () => true,
      client: {
        reviewDelivery: async (body: any) => {
          calls.push(body);
          return {
            summary: 'تم فحص المرفق المرئي والرابط المضمن.',
            contentRead: false,
            inspected: true,
            requirementsScope: 'PROJECT',
            met: [{ requirement: 'شاشة الدخول', evidence: 'تظهر شاشة تسجيل الدخول في الصورة', source: 'https://res.cloudinary.com/demo/image/upload/screen.png' }],
            potentialGaps: [],
            questionsForReviewer: ['هل تم تسليم الكود المصدري؟'],
            evidence: [{
              source: 'https://res.cloudinary.com/demo/image/upload/screen.png',
              sha256: 'b'.repeat(64),
              contentRead: false,
              excerpt: '',
              truncated: false,
              basis: 'VISUAL_INSPECTION_INLINE',
            }],
            unavailable: [],
            execution: { status: 'UNAVAILABLE', executed: false, reason: 'لا يشغل الكود' },
          };
        },
      },
    }
  );
  const res = await svc.review('client-1', 'proj-deliv', 'stage-1');
  assert.deepEqual(calls[0].deliverableLinks, ['https://github.com/org/repo']);
  assert.equal(res.reviewedInputs.attachmentContent, true);
  assert.match(res.contentNotice, /المرفقات المرئية/);
});
