import { prisma } from '../config/db';

// Specialty recommendation for the provider's "choose your specialty" step.
//
// Rule-based (NOT AI): every suggestion comes from real rows and the message says exactly which one, in this order of trust:
//   1. provider_history - the provider submitted proposals on requests of a specialty they have not registered yet
//   2. profile          - the provider's own profile (mainSpecialty / subSpecialties) names an active specialty/category not registered yet
//   3. popular          - the category with the most OPEN client requests right now (only categories where the provider has nothing registered)
//   none                - no data: hasRecommendation=false (the UI shows no suggestion)
// Only ACTIVE categories/specialties are ever suggested, and never one the provider already registered (any status).

export type RecommendationSource = 'provider_history' | 'profile' | 'popular' | 'none';
export type RecommendationReason = 'PROPOSAL_HISTORY' | 'PROFILE_MATCH' | 'OPEN_DEMAND' | 'NO_DATA';

export interface SpecialtyRecommendation {
  hasRecommendation: boolean;
  source: RecommendationSource;
  reason: RecommendationReason;
  message: string;
  categoryId: string | null;
  categoryName: string | null;
  specialtyIds: string[];
  specialtyNames: string[];
}

export interface RecommendationDb {
  providerProfile: { findUnique(args: any): Promise<any> };
  proposal: { findMany(args: any): Promise<any[]> };
  specialty: { findMany(args: any): Promise<any[]> };
  clientRequest: { groupBy(args: any): Promise<any[]> };
}

const NONE: SpecialtyRecommendation = {
  hasRecommendation: false, source: 'none', reason: 'NO_DATA', message: '',
  categoryId: null, categoryName: null, specialtyIds: [], specialtyNames: [],
};

const norm = (s: unknown) => String(s ?? '').replace(/[ً-ْـ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

interface Spec { id: string; nameAr: string; nameEn: string | null; categoryId: string; categoryName: string }

export async function computeSpecialtyRecommendation(db: RecommendationDb, userId: string): Promise<SpecialtyRecommendation> {
  const profile = await db.providerProfile.findUnique({
    where: { userId },
    select: { id: true, mainSpecialty: true, subSpecialties: true, providerSpecialties: { select: { specialtyId: true, specialty: { select: { categoryId: true } } } } },
  });
  if (!profile) return NONE;

  const rows = await db.specialty.findMany({
    where: { isActive: true, category: { isActive: true } },
    select: { id: true, nameAr: true, nameEn: true, categoryId: true, category: { select: { nameAr: true } } },
    orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }],
  });
  const specs: Spec[] = rows.map(r => ({ id: r.id, nameAr: r.nameAr, nameEn: r.nameEn ?? null, categoryId: r.categoryId, categoryName: r.category?.nameAr ?? '' }));
  const byId = new Map(specs.map(s => [s.id, s]));

  const registeredSpecIds = new Set<string>((profile.providerSpecialties ?? []).map((p: any) => p.specialtyId));
  const registeredCategoryIds = new Set<string>((profile.providerSpecialties ?? []).map((p: any) => p.specialty?.categoryId).filter(Boolean));
  const free = (s: Spec) => !registeredSpecIds.has(s.id);
  const result = (source: RecommendationSource, reason: RecommendationReason, message: string, category: { id: string; name: string }, chosen: Spec[]): SpecialtyRecommendation => ({
    hasRecommendation: true, source, reason, message, categoryId: category.id, categoryName: category.name,
    specialtyIds: chosen.map(s => s.id), specialtyNames: chosen.map(s => s.nameAr),
  });

  // 1) real proposal history
  const proposals = await db.proposal.findMany({
    where: { providerId: userId, clientRequestId: { not: null } },
    select: { clientRequest: { select: { specialtyId: true } } },
  });
  const proposalCount = new Map<string, number>();
  for (const p of proposals) {
    const id = p.clientRequest?.specialtyId as string | undefined;
    const s = id ? byId.get(id) : undefined;
    if (s && free(s)) proposalCount.set(s.id, (proposalCount.get(s.id) ?? 0) + 1);
  }
  if (proposalCount.size > 0) {
    const perCategory = new Map<string, number>();
    for (const [id, n] of proposalCount) { const s = byId.get(id)!; perCategory.set(s.categoryId, (perCategory.get(s.categoryId) ?? 0) + n); }
    const [topCat, total] = [...perCategory.entries()].sort((a, b) => b[1] - a[1])[0];
    const chosen = [...proposalCount.entries()].map(([id, n]) => ({ s: byId.get(id)!, n })).filter(x => x.s.categoryId === topCat)
      .sort((a, b) => b.n - a.n).slice(0, 5).map(x => x.s);
    const catName = chosen[0].categoryName;
    return result('provider_history', 'PROPOSAL_HISTORY',
      `قدّمت ${total === 1 ? 'عرضًا واحدًا' : `${total} عروض`} على طلبات في «${catName}» ولم تسجّل تخصصًا فيه بعد.`,
      { id: topCat, name: catName }, chosen);
  }

  // 2) the provider's own profile
  const mentioned = [profile.mainSpecialty, ...(profile.subSpecialties ?? [])].map(norm).filter(Boolean);
  if (mentioned.length > 0) {
    const matchedSpecs = specs.filter(s => free(s) && mentioned.some(m => m === norm(s.nameAr) || (s.nameEn && m === norm(s.nameEn))));
    if (matchedSpecs.length > 0) {
      const cat = matchedSpecs[0];
      const chosen = matchedSpecs.filter(s => s.categoryId === cat.categoryId).slice(0, 5);
      return result('profile', 'PROFILE_MATCH', `ذكرتَ «${chosen[0].nameAr}» في ملفك ولم تسجّله كتخصص للاعتماد بعد.`, { id: cat.categoryId, name: cat.categoryName }, chosen);
    }
    const catMatch = specs.find(s => !registeredCategoryIds.has(s.categoryId) && mentioned.includes(norm(s.categoryName)));
    if (catMatch) {
      return result('profile', 'PROFILE_MATCH', `ذكرتَ «${catMatch.categoryName}» في ملفك ولم تسجّل تخصصًا فيه بعد.`, { id: catMatch.categoryId, name: catMatch.categoryName }, []);
    }
  }

  // 3) real demand: open client requests
  const groups = await db.clientRequest.groupBy({ by: ['specialtyId'], where: { status: 'OPEN' }, _count: { _all: true } });
  const openBySpec = new Map<string, number>();
  const openByCat = new Map<string, number>();
  for (const g of groups) {
    const s = byId.get(g.specialtyId);
    const n = g._count?._all ?? 0;
    if (!s || n <= 0) continue;
    openBySpec.set(s.id, n);
    openByCat.set(s.categoryId, (openByCat.get(s.categoryId) ?? 0) + n);
  }
  const candidates = [...openByCat.entries()].filter(([cid]) => !registeredCategoryIds.has(cid)).sort((a, b) => b[1] - a[1]);
  if (candidates.length > 0) {
    const [cid, total] = candidates[0];
    const chosen = specs.filter(s => s.categoryId === cid && free(s) && openBySpec.has(s.id)).sort((a, b) => (openBySpec.get(b.id)! - openBySpec.get(a.id)!)).slice(0, 3);
    const catName = byId.get(chosen[0]?.id ?? '')?.categoryName ?? specs.find(s => s.categoryId === cid)!.categoryName;
    return result('popular', 'OPEN_DEMAND', `«${catName}» هو القسم الأكثر طلبات مفتوحة حاليًا على المنصة (${total} ${total === 1 ? 'طلب' : 'طلبات'}).`, { id: cid, name: catName }, chosen);
  }

  return NONE;
}

export const providerSpecialtyRecommendationService = {
  getForProvider: (userId: string) => computeSpecialtyRecommendation(prisma as unknown as RecommendationDb, userId),
};
