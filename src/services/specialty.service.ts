import { prisma } from '../config/db';
import { SpecialtyVerificationStatus } from '@prisma/client';
import { logger } from '../config/logger';
import { resolveCategorySlug } from './skills-catalog.service';
import { assertLegacySpecialtyProofs } from './accreditation-proof.service';

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
            providerSpecialties: { where: { isActive: true } }
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

    // Re-selecting a specialty the provider already passed / was approved for never resets it to PENDING_PROOF.
    const existing = await prisma.providerSpecialty.findUnique({
      where: { providerProfileId_specialtyId: { providerProfileId, specialtyId: finalSpecialtyId } },
      select: { status: true, isPassed: true }
    });
    const keepsProgress = !!existing && (existing.isPassed || existing.status === SpecialtyVerificationStatus.APPROVED || existing.status === SpecialtyVerificationStatus.UNDER_AI_REVIEW || existing.status === SpecialtyVerificationStatus.LOCKED_OUT);
    return prisma.providerSpecialty.upsert({
      where: {
        providerProfileId_specialtyId: {
          providerProfileId,
          specialtyId: finalSpecialtyId
        }
      },
      update: {
        subSpecialties,
        ...(keepsProgress ? {} : { status: SpecialtyVerificationStatus.PENDING_PROOF })
      },
      create: {
        providerProfileId,
        specialtyId: finalSpecialtyId,
        subSpecialties,
        status: SpecialtyVerificationStatus.PENDING_PROOF
      }
    });
  }

  /**
   * The specialties chosen in the signup / setup wizard (ProviderProfile.mainSpecialty = the marketplace category, subSpecialties = the chosen
   * specialties of that category) become the provider's ProviderSpecialty rows, so every page that reads provider_specialties (model upload,
   * market, accreditation) sees them. CREATE-ONLY: an existing row (any status) is never touched, so a re-run never resets progress and never
   * duplicates (unique providerProfileId + specialtyId). Returns the ids of the provider's rows for the chosen specialties.
   */
  async syncProviderSpecialtiesFromProfile(profileId: string, db: typeof prisma = prisma): Promise<{ created: number; ids: string[] }> {
    const profile = await db.providerProfile.findUnique({ where: { id: profileId }, select: { id: true, mainSpecialty: true, subSpecialties: true } });
    const names = [...new Set((profile?.subSpecialties ?? []).map(n => String(n).trim()).filter(Boolean))];
    if (!profile || !names.length) return { created: 0, ids: [] };
    const categorySlug = await resolveCategorySlug(db as any, profile.mainSpecialty);
    const specialties = await db.specialty.findMany({
      where: { isActive: true, nameAr: { in: names }, ...(categorySlug ? { category: { slug: categorySlug } } : {}) },
      select: { id: true }
    });
    let created = 0;
    const ids: string[] = [];
    for (const sp of specialties) {
      const where = { providerProfileId_specialtyId: { providerProfileId: profile.id, specialtyId: sp.id } };
      const before = await db.providerSpecialty.findUnique({ where, select: { id: true } });
      const row = await db.providerSpecialty.upsert({
        where,
        update: {},
        create: { providerProfileId: profile.id, specialtyId: sp.id, subSpecialties: [], status: SpecialtyVerificationStatus.PENDING_PROOF },
        select: { id: true }
      });
      if (!before) created += 1;
      ids.push(row.id);
    }
    return { created, ids };
  }

  /**
   * The setup test is the assessment of the specialties chosen at signup: its result is recorded on those rows as a FACT (taken, score, passed), exactly
   * like a specialty assessment, and never approves anything (status stays; the admin approves the proof / samples). A row that already passed, is
   * approved or is locked out is left untouched.
   */
  async applySetupTestToSpecialties(profileId: string, score: number, passed: boolean, db: typeof prisma = prisma): Promise<number> {
    await this.syncProviderSpecialtiesFromProfile(profileId, db);
    const profile = await db.providerProfile.findUnique({ where: { id: profileId }, select: { subSpecialties: true } });
    const names = (profile?.subSpecialties ?? []).map(n => String(n).trim()).filter(Boolean);
    if (!names.length) return 0;
    const rows = await db.providerSpecialty.findMany({
      where: { providerProfileId: profileId, isActive: true, specialty: { nameAr: { in: names } } },
      select: { id: true, status: true, isPassed: true }
    });
    let updated = 0;
    for (const row of rows) {
      if (row.isPassed || row.status === SpecialtyVerificationStatus.APPROVED || row.status === SpecialtyVerificationStatus.LOCKED_OUT) continue;
      await db.providerSpecialty.update({
        where: { id: row.id },
        data: { hasTakenAssessment: true, latestScore: score, quizScore: score, isPassed: passed, passedAt: passed ? new Date() : null }
      });
      updated += 1;
    }
    return updated;
  }

  /** Best-effort wrapper for the call sites that must never fail because of this sync (the profile save already succeeded). */
  async trySyncProviderSpecialties(profileId: string): Promise<void> {
    try { await this.syncProviderSpecialtiesFromProfile(profileId); } catch (error: any) { logger.error(`[SpecialtyService] could not sync provider specialties (profileId=${profileId}): ${error?.message}`); }
  }

  async uploadWorkSamples(providerSpecialtyId: string, samplesData: any[], userId?: string) {
    // The proof documents are mandatory (same rule as the main approval request): at least one stored, owned proof of this specialty, new here or already completed.
    const proofRefs = samplesData.flatMap(s => [s?.privateProofUrl, ...(Array.isArray(s?.proofs) ? s.proofs.map((p: any) => p?.url) : [])]);
    await assertLegacySpecialtyProofs(prisma as any, { userId: userId ?? '', providerSpecialtyId, proofRefs });
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

}

export const specialtyService = new SpecialtyService();
