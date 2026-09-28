import { prisma } from '../config/db';

// F15b (security follow-up batch): this list's "aiMatchScore"/"aiNote"/
// "aiPriceEval" fields are, and always have been, a 100%-deterministic
// keyword/heuristic scoring engine — there is no Gemini/OpenAI call
// anywhere in this file. It is intentionally NOT migrated to Gemini: this
// endpoint scores every filtered/sorted OPEN request on every request
// (unbounded candidate count, live search/sort/pagination), which is a
// fundamentally different shape from the "rank top-N from a bounded
// candidate set" pattern the shared Gemini matching engine
// (ai-matching-engine.service.ts, i.e. F15) was designed for — running an
// arbitrarily large, frequently-refreshed list through a per-request Gemini
// call would be slow, costly, and non-deterministic across reloads. The
// field names are kept as-is (also used by the persisted Proposal.aiMatchScore
// column elsewhere — out of scope here, no Prisma schema changes) but the
// wording below no longer claims generative AI produced the ranking.

export class ExploreRequestsService {
  public async getExploreRequests(providerId: string, filters: { category?: string; tab?: string; sortBy?: string; search?: string }) {

    // Browsing OPEN requests is NOT gated by specialty verification status.
    // Any authenticated, active Provider may see all OPEN requests by default
    // ("كل التخصصات" — matches the original P-PR-002 design). The provider's
    // own specialties (regardless of PENDING_PROOF/UNDER_AI_REVIEW/REJECTED/
    // APPROVED status) are only used to power the optional specialty filter
    // and the match/recommendation scoring below — never to hide requests.
    const providerProfile = await prisma.providerProfile.findUnique({
      where: { userId: providerId },
      include: {
        providerSpecialties: {
          where: {
            isActive: true
          },
          include: { specialty: true }
        }
      }
    });

    const providerSpecialtyNames = (providerProfile?.providerSpecialties || []).flatMap(ps => [
      ps.specialty?.nameAr,
      ps.specialty?.name,
      ps.specialty?.nameEn,
      ...(ps.subSpecialties || [])
    ]).filter(Boolean) as string[];

    const providerKeywords = Array.from(new Set([
      ...providerSpecialtyNames
    ])).map(k => k.toLowerCase().trim()).filter(k => k.length > 0);

    // 2. Fetch active projects & client requests from DB
    const [clientRequests, legacyProjects] = await Promise.all([
      prisma.clientRequest.findMany({
        where: {
          status: 'OPEN'
        },
        include: {
          specialty: true,
          clientProfile: {
            include: { user: true }
          },
          proposals: { where: { providerId } }
        }
      }),
      prisma.project.findMany({
        where: { status: 'OPEN' },
        include: {
          client: { select: { accountType: true } },
          proposals: { where: { providerId } },
          projectProposals: { where: { providerId } },
          savedBy: { where: { providerId } }
        }
      })
    ]);

    // Process ClientRequests first (Primary source of truth)
    const unifiedList: any[] = [];
    const seenProjectIds = new Set<string>();

    for (const cr of clientRequests) {
      seenProjectIds.add(cr.id); // Mark ID as seen regardless of match result to prevent fallback to stale Project records

      const hasApplied = cr.proposals.length > 0;
      const isSaved = false;

      const projectSpecialty = cr.specialty?.nameAr || cr.specialty?.name || '';
      const subSpecs = cr.subSpecialties || [];
      const reqSkills = cr.requiredSkills || [];

      // Every OPEN client request is browsable regardless of specialty match —
      // see explore-requests investigation. providerKeywords is only consulted
      // later for the optional category filter and match-score/recommendation.
      unifiedList.push({
        id: cr.id,
        title: cr.title,
        specialty: projectSpecialty || 'عام',
        category: projectSpecialty || 'عام',
        subSpecialties: subSpecs,
        requirements: reqSkills,
        description: cr.description,
        budgetMin: cr.minBudget || 0,
        budgetMax: cr.maxBudget || 0,
        durationDays: cr.expectedDurationDays || 14,
        proposalsCount: cr.proposalsCount || cr.proposals.length,
        clientType: cr.preferredProviderType === 'COMPANY' ? 'شركة' : 'فرد',
        createdAt: cr.createdAt,
        hasApplied,
        isSaved,
        isClientRequest: true
      });
    }

    // Process Legacy Projects (Only for projects not created as ClientRequest)
    for (const p of legacyProjects) {
      if (seenProjectIds.has(p.id)) continue;
      seenProjectIds.add(p.id);

      const hasApplied = p.proposals.length > 0 || ((p as any).projectProposals && (p as any).projectProposals.length > 0);
      const isSaved = p.savedBy.length > 0;

      const projectSpecialty = p.specialty || '';
      const subSpecs = p.subSpecialties || [];
      const reqs = p.requirements || [];

      const isCompany = p.client && p.client.accountType && p.client.accountType.includes('COMPANY');
      unifiedList.push({
        id: p.id,
        title: p.title,
        specialty: projectSpecialty || 'عام',
        category: projectSpecialty || 'عام',
        subSpecialties: subSpecs,
        requirements: reqs,
        description: p.description,
        budgetMin: p.budgetMin || 0,
        budgetMax: p.budgetMax || 0,
        durationDays: p.deliveryDays || 14,
        proposalsCount: p.proposalsCount || (p.proposals.length + ((p as any).projectProposals ? (p as any).projectProposals.length : 0)),
        clientType: isCompany ? 'شركة' : 'فرد',
        createdAt: p.createdAt,
        hasApplied,
        isSaved,
        isClientRequest: false
      });
    }

    // 3. Filter by Selected Category Filter (if specified and not 'ALL')
    let filteredList = unifiedList;
    if (filters.category && filters.category !== 'ALL' && filters.category !== 'all') {
      const catFilterLower = filters.category.toLowerCase();
      filteredList = filteredList.filter(item => 
        (item.category || '').toLowerCase().includes(catFilterLower) ||
        catFilterLower.includes((item.category || '').toLowerCase())
      );
    }

    // Filter by Search Query
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      filteredList = filteredList.filter(item => 
        item.title.toLowerCase().includes(searchLower) ||
        item.description.toLowerCase().includes(searchLower)
      );
    }

    // 4. Calculate statuses & AI Match Scores
    let allCount = 0;
    let notAppliedCount = 0;
    let appliedCount = 0;
    let savedCount = 0;

    let processedProjects = filteredList.map(item => {
      allCount++;
      if (item.hasApplied) appliedCount++;
      else notAppliedCount++;
      if (item.isSaved) savedCount++;

      // AI Match Score Calculation based on Provider Keyword Overlap
      let aiMatchScore = 85;
      const reqLower = item.requirements || [];
      const categoryLower = (item.category || '').toLowerCase();
      
      let matchedCount = 0;
      if (providerKeywords.length > 0) {
        matchedCount = reqLower.filter((r: string) => providerKeywords.some(pk => pk.includes(r) || r.includes(pk))).length;
      }

      const hashValue = item.id.split('').reduce((acc: number, char: string) => acc + char.charCodeAt(0), 0);
      const deterministicOffset = (hashValue % 10);

      if (matchedCount > 0) {
        aiMatchScore = Math.min(99, 88 + Math.round((matchedCount / Math.max(reqLower.length, 1)) * 8) + (hashValue % 4));
      } else if (providerKeywords.some(pk => categoryLower.includes(pk) || pk.includes(categoryLower))) {
        aiMatchScore = Math.min(96, 86 + deterministicOffset);
      } else {
        aiMatchScore = 82 + deterministicOffset;
      }

      // Financial appraisal
      let aiSuggestedBudget = 'غير محدد';
      let aiPriceEval = 'عادل ومطابق لمتطلبات السوق';
      const minB = item.budgetMin || 0;
      const maxB = item.budgetMax || 0;

      if (minB > 0 && maxB > 0) {
        const avgBudget = (minB + maxB) / 2;
        if (avgBudget < 1500) {
          aiSuggestedBudget = `${Math.round(minB * 1.1)} - ${Math.round(maxB * 1.25)} $`;
          aiPriceEval = 'أقل قليلاً من التقدير - يمكنك طلب تفاوض';
        } else if (avgBudget <= 8000) {
          aiSuggestedBudget = `${minB} - ${maxB} $`;
          aiPriceEval = 'ميزانية عادلة ومطابقة للمواصفات';
        } else {
          aiSuggestedBudget = `${Math.round(minB * 0.95)} - ${maxB} $`;
          aiPriceEval = 'ميزانية سخية وممتازة - فرصة كبرى';
        }
      } else if (minB > 0) {
        aiSuggestedBudget = `${minB} $ فأكثر`;
        aiPriceEval = 'سعر أساسي مناسب للمنافسة';
      } else {
        aiSuggestedBudget = '1,500 - 4,000 $';
        aiPriceEval = 'ميزانية تقديرية مفتوحة حسب الجهد';
      }

      // Timeline appraisal
      let aiSuggestedDuration = `${item.durationDays || 14} يوم`;
      let aiDurationEval = 'مدة واقعية ومناسبة';
      if ((item.durationDays || 14) <= 7) {
        aiDurationEval = 'مدة ضيقة - تتطلب سرعة وتفرغ';
      } else if ((item.durationDays || 14) >= 25) {
        aiDurationEval = 'جدول زمني مريح ومرن للتنفيذ';
      }

      // Strategic match note — deterministic wording only; never attributed
      // to generative AI (see the file-level note above).
      let aiNote = '';
      if (item.proposalsCount <= 1) {
        aiNote = `العميل (${item.clientType}) والمنافسة منخفضة جداً في هذا المشروع (${item.proposalsCount ? 'عرض واحد فقط' : 'لا توجد عروض'}). التوافق عالي، ننصح بتقديم العرض فوراً.`;
      } else if (aiMatchScore >= 88) {
        aiNote = `نظام المطابقة في وسيط يبرز هذا الطلب كأفضل توافق مع تخصصك (${aiMatchScore}%)! خبرتك تعطيك أفضلية كبرى رغم وجود ${item.proposalsCount} عروض منافسة.`;
      } else {
        aiNote = `فرصة جيدة لبناء سمعة ممتازة مع عميل (${item.clientType}). احرص على تضمين نماذج سابقة وتفصيل خطوات العمل لكسب العرض.`;
      }

      // Time ago formatting
      const hoursAgo = Math.floor((new Date().getTime() - item.createdAt.getTime()) / (1000 * 60 * 60));
      const createdAtFormatted = hoursAgo === 0 ? 'منذ قليل' : (hoursAgo < 24 ? `قبل ${hoursAgo} ساعة` : `قبل ${Math.floor(hoursAgo / 24)} يوم`);

      return {
        id: item.id,
        title: item.title,
        specialty: item.specialty,
        category: item.category,
        subSpecialties: item.subSpecialties,
        requirements: item.requirements,
        description: item.description,
        budgetMin: item.budgetMin || 0,
        budgetMax: item.budgetMax || 0,
        durationDays: item.durationDays || 0,
        proposalsCount: item.proposalsCount,
        clientType: item.clientType,
        createdAtFormatted,
        aiMatchScore,
        aiSuggestedBudget,
        aiPriceEval,
        aiSuggestedDuration,
        aiDurationEval,
        aiNote,
        generationSource: 'DETERMINISTIC' as const,
        hasApplied: item.hasApplied,
        isSaved: item.isSaved,
        createdAt: item.createdAt
      };
    });

    // 5. Apply Tab Filter
    if (filters.tab === 'NOT_APPLIED') {
      processedProjects = processedProjects.filter(p => !p.hasApplied);
    } else if (filters.tab === 'APPLIED') {
      processedProjects = processedProjects.filter(p => p.hasApplied);
    } else if (filters.tab === 'SAVED') {
      processedProjects = processedProjects.filter(p => p.isSaved);
    }

    // 6. Apply Sorting
    if (filters.sortBy === 'NEWEST') {
      processedProjects.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    } else if (filters.sortBy === 'BUDGET_HIGH' || filters.sortBy === 'BUDGET') {
      processedProjects.sort((a, b) => b.budgetMax - a.budgetMax);
    } else if (filters.sortBy === 'CLOSING_SOON' || filters.sortBy === 'CLOSING') {
      processedProjects.sort((a, b) => a.durationDays - b.durationDays);
    } else {
      // Default 'MATCH'
      processedProjects.sort((a, b) => b.aiMatchScore - a.aiMatchScore);
    }

    return {
      counts: {
        all: allCount,
        notApplied: notAppliedCount,
        applied: appliedCount,
        saved: savedCount
      },
      providerSpecialties: Array.from(new Set(providerSpecialtyNames)),
      projects: processedProjects
    };
  }

  public async toggleSave(providerId: string, projectId: string) {
    const existing = await prisma.savedProject.findUnique({
      where: {
        providerId_projectId: {
          providerId,
          projectId
        }
      }
    });

    let isSaved = false;
    if (existing) {
      await prisma.savedProject.delete({ where: { id: existing.id } });
      isSaved = false;
    } else {
      await prisma.savedProject.create({
        data: { providerId, projectId }
      });
      isSaved = true;
    }

    // Recalculate updated total saved count
    const savedCount = await prisma.savedProject.count({
      where: { providerId }
    });

    return {
      projectId,
      isSaved,
      savedCount
    };
  }
}

export const exploreRequestsService = new ExploreRequestsService();
