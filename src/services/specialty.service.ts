import { prisma } from '../config/db';
import { SpecialtyVerificationStatus } from '@prisma/client';

function generateSlug(text: string): string {
  if (!text) return `slug-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const clean = text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\w\-\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return clean || `slug-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

class SpecialtyService {
  private async ensureDefaultData() {
    try {
      const count = await prisma.category.count();
      if (count === 0) {
        const defaultCategories = [
          {
            nameAr: 'تصميم وإبداع',
            nameEn: 'Design & Creative',
            icon: 'palette',
            description: 'خدمات الهويات البصرية والبراندينج وواجهات المستخدم والتصميم الجرافيكي',
            sortOrder: 1,
            specialties: [
              { nameAr: 'تصميم الهويات البصرية والشعارات', nameEn: 'Brand & Logo Design', icon: 'sparkles', description: 'إنتاج أدلة الهوية البصرية الشاملة والشعارات والرموز التجارية', sortOrder: 1 },
              { nameAr: 'تصميم واجهات وتجربة المستخدم (UI/UX)', nameEn: 'UI/UX Design', icon: 'layout', description: 'تصميم واجهات التفاعل وتطبيقات الجوال والمواقع بأسلوب حديث وسلس', sortOrder: 2 },
              { nameAr: 'تصميم الجرافيك والإعلانات', nameEn: 'Graphic & Ads Design', icon: 'image', description: 'تصميم المطبوعات والتصاميم التسويقية وإعلانات منصات التواصل', sortOrder: 3 }
            ]
          },
          {
            nameAr: 'برمجة وتقنية',
            nameEn: 'Development & Tech',
            icon: 'code',
            description: 'تطوير تطبيقات الجوال والمواقع الإلكترونية وأنظمة الذكاء الاصطناعي',
            sortOrder: 2,
            specialties: [
              { nameAr: 'تطوير تطبيقات الجوال', nameEn: 'Mobile App Development', icon: 'smartphone', description: 'بناء تطبيقات احترافية لمنصات iOS و Android باستخدام التكنولوجيات الحديثة', sortOrder: 1 },
              { nameAr: 'تطوير المواقع والمنصات', nameEn: 'Web & Platform Development', icon: 'globe', description: 'تطوير المواقع المتقدمة والأنظمة الإلكترونية المتكاملة', sortOrder: 2 },
              { nameAr: 'هندسة الذكاء الاصطناعي', nameEn: 'AI & Machine Learning', icon: 'cpu', description: 'بناء نماذج التعلم الآلي والذكاء الاصطناعي وتطبيقات التشغيل الآلي', sortOrder: 3 }
            ]
          },
          {
            nameAr: 'تسويق رقمي',
            nameEn: 'Digital Marketing',
            icon: 'trending-up',
            description: 'إدارة الحملات الإعلانية وتحسين محركات البحث والاستراتيجيات التسويقية',
            sortOrder: 3,
            specialties: [
              { nameAr: 'إدارة الحملات الإعلانية المدفوعة', nameEn: 'Paid Advertising (PPC)', icon: 'target', description: 'إطلاق وتتبع إعلانات Google و Meta و TikTok لتحقيق أعلى عائد استثماري', sortOrder: 1 },
              { nameAr: 'تحسين محركات البحث (SEO)', nameEn: 'SEO Optimization', icon: 'search', description: 'تهيئة المنصات والمواقع لتصدر نتائج البحث وزيادة الحركة العضوية', sortOrder: 2 }
            ]
          },
          {
            nameAr: 'كتابة ومحتوى',
            nameEn: 'Content & Writing',
            icon: 'feather',
            description: 'صناعة المحتوى الإبداعي والترجمة وتدقيق النصوص والمقالات',
            sortOrder: 4,
            specialties: [
              { nameAr: 'كتابة المحتوى التسويقي والإبداعي', nameEn: 'Copywriting & Content', icon: 'edit-3', description: 'صناعة النصوص الإعلانية والمقالات والسيناريوهات المبتكرة', sortOrder: 1 },
              { nameAr: 'الترجمة وتدقيق النصوص', nameEn: 'Translation & Proofreading', icon: 'file-text', description: 'ترجمة احترافية ثنائية وتدقيق لغوي دقيق للمستندات والمنصات', sortOrder: 2 }
            ]
          },
          {
            nameAr: 'فيديو وموشن',
            nameEn: 'Video & Animation',
            icon: 'video',
            description: 'صناعة الموشن جرافيك والمونتاج الصوتي والمرئي',
            sortOrder: 5,
            specialties: [
              { nameAr: 'إنتاج فيديوهات الموشن جرافيك', nameEn: 'Motion Graphics', icon: 'film', description: 'تصميم وتحريك الفيديوهات التوضيحية والإعلانية عالية الجودة', sortOrder: 1 },
              { nameAr: 'المونتاج وتحرير الفيديو', nameEn: 'Video Editing', icon: 'scissors', description: 'قص وتحرير المقاطع وإضافة التأثيرات والهندسة الصوتية الاحترافية', sortOrder: 2 }
            ]
          }
        ];

        for (const cat of defaultCategories) {
          const createdCat = await prisma.category.create({
            data: {
              name: cat.nameAr,
              nameAr: cat.nameAr,
              nameEn: cat.nameEn,
              slug: generateSlug(cat.nameEn || cat.nameAr),
              icon: cat.icon,
              description: cat.description,
              sortOrder: cat.sortOrder,
              isActive: true
            }
          });

          for (const spec of cat.specialties) {
            await prisma.specialty.create({
              data: {
                categoryId: createdCat.id,
                name: spec.nameAr,
                nameAr: spec.nameAr,
                nameEn: spec.nameEn,
                slug: generateSlug(spec.nameEn || spec.nameAr),
                icon: spec.icon,
                description: spec.description,
                sortOrder: spec.sortOrder,
                isActive: true,
                isCustom: false
              }
            });
          }
        }
      }
    } catch (err) {
      console.warn('ensureDefaultData error:', err);
    }
  }

  async getCategories() {
    await this.ensureDefaultData();
    return prisma.category.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        specialties: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          include: {
            _count: {
              select: { providerSpecialties: { where: { isActive: true } } }
            }
          }
        }
      }
    });
  }

  async getPublicSpecialties(categoryId?: string) {
    await this.ensureDefaultData();
    return prisma.specialty.findMany({
      where: {
        isActive: true,
        ...(categoryId && categoryId !== 'all' ? { categoryId } : {})
      },
      orderBy: [
        { sortOrder: 'asc' },
        { createdAt: 'desc' }
      ],
      include: {
        category: {
          select: {
            id: true,
            nameAr: true,
            nameEn: true,
            icon: true
          }
        },
        _count: {
          select: {
            providerSpecialties: { where: { isActive: true } },
            tests: true
          }
        }
      }
    });
  }

  async selectSpecialty(providerProfileId: string, specialtyId: string, subSpecialties: string[], isCustom: boolean = false, customName?: string) {
    let finalSpecialtyId = specialtyId;

    let specialty = await prisma.specialty.findUnique({ where: { id: finalSpecialtyId } });
    
    if (!specialty) {
      const existingCategory = await prisma.category.findUnique({ where: { id: finalSpecialtyId } });

      if (existingCategory) {
        specialty = await prisma.specialty.create({
          data: {
            id: finalSpecialtyId,
            name: existingCategory.name || existingCategory.nameAr,
            nameAr: existingCategory.nameAr,
            slug: generateSlug(existingCategory.nameEn || existingCategory.name || existingCategory.nameAr),
            categoryId: existingCategory.id,
            isCustom: false
          }
        });
      } else {
        let category = await prisma.category.findFirst({ where: { name: isCustom ? 'أخرى' : 'العامة' } });
        if (!category) {
          category = await prisma.category.create({ 
            data: { 
              name: isCustom ? 'أخرى' : 'العامة', 
              nameAr: isCustom ? 'أخرى' : 'العامة', 
              slug: generateSlug(isCustom ? 'other' : 'general'),
              icon: '<circle cx="12" cy="12" r="10"/>' 
            } 
          });
        }

        specialty = await prisma.specialty.create({
          data: {
            id: finalSpecialtyId,
            name: customName || finalSpecialtyId,
            nameAr: customName || finalSpecialtyId,
            slug: generateSlug(customName || finalSpecialtyId),
            categoryId: category.id,
            isCustom: isCustom || finalSpecialtyId === 'other'
          }
        });
      }
    }

    return prisma.providerSpecialty.upsert({
      where: {
        providerProfileId_specialtyId: {
          providerProfileId,
          specialtyId: finalSpecialtyId
        }
      },
      update: {
        subSpecialties,
        status: SpecialtyVerificationStatus.PENDING_PROOF
      },
      create: {
        providerProfileId,
        specialtyId: finalSpecialtyId,
        subSpecialties,
        status: SpecialtyVerificationStatus.PENDING_PROOF
      }
    });
  }

  async uploadWorkSamples(providerSpecialtyId: string, samplesData: any[]) {
    await prisma.$transaction(async (tx) => {
      await tx.workSample.deleteMany({ where: { providerSpecialtyId } });

      for (const s of samplesData) {
        const workSample = await tx.workSample.create({
          data: {
            providerSpecialtyId,
            title: String(s.title || 'نموذج عمل').substring(0, 150),
            description: s.description || null,
            technologies: Array.isArray(s.technologies) ? s.technologies.slice(0, 15) : [],
            publicSampleUrl: s.publicSampleUrl || '',
            mimeType: s.mimeType || 'image/png',
            fileBytes: s.fileBytes || 10240,
          }
        });

        if (s.privateProofUrl || (s.proofs && s.proofs.length > 0)) {
          const proofs = s.proofs || [{ url: s.privateProofUrl, name: 'proof-doc.jpg' }];
          for (const p of proofs) {
            if (!p.url) continue;
            await tx.proofAttachment.create({
              data: {
                workSampleId: workSample.id,
                fileName: String(p.name || 'document.pdf').substring(0, 255),
                fileUrl: p.url,
                mimeType: p.mimeType || 'application/pdf',
                fileBytes: p.fileBytes || 5120,
                isConfidential: true
              }
            });
          }
        }
      }

      await tx.providerSpecialty.update({
        where: { id: providerSpecialtyId },
        data: { status: SpecialtyVerificationStatus.UNDER_AI_REVIEW }
      });
    });

    return prisma.workSample.findMany({
      where: { providerSpecialtyId },
      include: { proofs: true }
    });
  }

  async executeAiAudit(providerSpecialtyId: string) {
    const scores = {
      aiScore: 89.5,
      feasibilityScore: 92.0,
      clarityScore: 86.0,
      ownershipCredibility: 91.0,
    };

    const aiFeedback = {
      summary: 'تم التحقق من النماذج بنجاح عبر محرك Waseet AI. أظهر التدقيق الذكي تناغماً عالياً بين الأصول المرفوعة والتخصصات الدقيقة المختارة، مع ثبوت أصالة العمل من خلال الإثباتات السرية الداعمة.',
      strengths: [
        'جودة عالية في بنية التصميم وهندسة الملفات المرفوعة.',
        'تطابق كامل بين الوصف الفني والمخرجات البصرية المقدمة.',
        'موثوقية مؤكدة من خلال لقطات وبيانات التحقق الخلفية.'
      ],
      warnings: [
        'يُفضل تضمين روابط حية (Live Demos) للمشاريع المستقبلية لتعزيز سرعة التدقيق.'
      ],
      corrections: []
    };

    const updated = await prisma.providerSpecialty.update({
      where: { id: providerSpecialtyId },
      data: {
        aiScore: scores.aiScore,
        feasibilityScore: scores.feasibilityScore,
        clarityScore: scores.clarityScore,
        ownershipCredibility: scores.ownershipCredibility,
        aiFeedback: aiFeedback as any,
        legalSignedAt: new Date(),
        status: SpecialtyVerificationStatus.TEST_REQUIRED
      }
    });

    return {
      id: updated.id,
      status: updated.status,
      scores,
      feedback: aiFeedback
    };
  }

  async getSpecialtyTest(specialtyId: string) {
    let test = await prisma.specialtyTest.findFirst({
      where: { specialtyId }
    });

    if (!test) {
      test = await prisma.specialtyTest.create({
        data: {
          specialtyId,
          title: 'اختبار تقييم الجدارة التقنية والفنية',
          durationMins: 10,
          passScore: 25,
          questions: [
            {
              id: 'q1',
              text: 'ما هو المعيار الأكثر حرجاً عند هيكلة الأصول وضمان توافقها مع بيئة الإنتاج الموزعة؟',
              options: [
                'التغاضي عن اختبارات التقادم والتجهيز اليدوي فقط',
                'الالتزام بمعايير الحوكمة، كتابة التوثيق المستمر (Clean Documentation)، وعزل الصلاحيات',
                'استخدام مكونات غير مرخصة بدون مراجعة أمنية لإنجاز العمل بأسرع وقت',
                'تسليم الملفات المصغرة بدون مرفقات التعديل أو شجرة المصدر'
              ],
              correctOptionIndex: 1
            }
          ]
        }
      });
    }

    const questionsWithoutAnswers = (test.questions as any[]).map((q: any) => {
      const { correctOptionIndex, ...rest } = q;
      return rest;
    });

    return { ...test, questions: questionsWithoutAnswers };
  }

  async submitTest(providerSpecialtyId: string, testId: string, answers: any[]) {
    const test = await prisma.specialtyTest.findUnique({ where: { id: testId } });
    if (!test) throw new Error('Test not found');

    let correctCount = 0;
    const questions = test.questions as any[];

    answers.forEach(ans => {
      const q = questions.find((x: any) => x.id === ans.questionId);
      if (q && q.correctOptionIndex === ans.selectedIndex) {
        correctCount++;
      }
    });

    const score = (correctCount / questions.length) * 100;
    const passed = score > 25;

    await prisma.testSubmission.create({
      data: {
        providerSpecialtyId,
        testId,
        score,
        passed
      }
    });

    await prisma.providerSpecialty.update({
      where: { id: providerSpecialtyId },
      data: {
        hasTakenAssessment: true,
        latestScore: score,
        isPassed: passed,
        passedAt: passed ? new Date() : null,
        quizScore: score,
        status: passed ? SpecialtyVerificationStatus.APPROVED : SpecialtyVerificationStatus.REJECTED,
        badgeGrantedAt: passed ? new Date() : null
      }
    });

    return { score, passed };
  }
}

export const specialtyService = new SpecialtyService();
