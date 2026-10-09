import { prisma } from '../config/db';

// Specialty suggestion for the client's "create request" step 1. Rule-based (NOT AI), read/compute only, nothing is saved.
// Sources, in order of trust:
//   1. text_match     - the text the client typed (search / title / description) matches category and specialty names, slugs and descriptions
//   2. client_history - the client's own earlier (non-draft) requests
//   3. popular        - the category with the most OPEN client requests on the platform right now
//   none              - nothing to suggest (hasRecommendation=false)
// Only ACTIVE categories/specialties are ever suggested.

export type ClientRecommendationSource = 'text_match' | 'client_history' | 'popular' | 'none';
export type ClientRecommendationReason = 'TEXT_MATCH' | 'CLIENT_HISTORY' | 'OPEN_DEMAND' | 'NO_DATA';

export interface ClientSpecialtyRecommendation {
  hasRecommendation: boolean;
  source: ClientRecommendationSource;
  reason: ClientRecommendationReason;
  message: string;
  categoryId: string | null;
  categoryName: string | null;
  specialtyIds: string[];
  specialtyNames: string[];
  /** text_match only: share of the typed words that matched (0..1). null for the other sources. */
  confidence: number | null;
}

export interface ClientRecommendationDb {
  specialty: { findMany(args: any): Promise<any[]> };
  clientRequest: { findMany(args: any): Promise<any[]>; groupBy(args: any): Promise<any[]> };
}

const NONE: ClientSpecialtyRecommendation = {
  hasRecommendation: false, source: 'none', reason: 'NO_DATA', message: '',
  categoryId: null, categoryName: null, specialtyIds: [], specialtyNames: [], confidence: null,
};

export const MAX_RECOMMENDATION_TEXT = 500;
const STOP = new Set(['في', 'من', 'على', 'عن', 'الى', 'إلى', 'مع', 'او', 'أو', 'ان', 'أن', 'هذا', 'هذه', 'ذلك', 'اريد', 'أريد', 'ابغى', 'محتاج', 'احتاج', 'أحتاج', 'لدي', 'عندي', 'لعمل', 'عمل', 'طلب', 'خدمة', 'for', 'the', 'and', 'with', 'a', 'an', 'to', 'of']);

const clean = (s: unknown) => String(s ?? '').toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
// Skeleton of a word: drops "ال", the long vowels and a final ة, so موقع / المواقع / مواقع meet; compared by prefix so plurals (تطبيق / تطبيقات) meet too.
const skeleton = (w: string) => w.replace(/^ال/, '').replace(/[اويء]/g, '').replace(/ة$/, '');
const wordsOf = (s: string) => clean(s).split(' ').filter(Boolean);

function hits(token: string, text: string): boolean {
  if (!text) return false;
  const c = clean(text);
  if (c.includes(token)) return true;
  const sk = skeleton(token);
  if (sk.length < 3) return false;
  return wordsOf(text).some(w => { const ws = skeleton(w); return ws.length >= 3 && ws.startsWith(sk); });
}

interface Spec { id: string; name: string; nameEn: string; slug: string; description: string; categoryId: string; categoryName: string; categoryNameEn: string; categorySlug: string; categoryDescription: string }

export async function computeClientSpecialtyRecommendation(db: ClientRecommendationDb, userId: string, rawText?: string): Promise<ClientSpecialtyRecommendation> {
  const rows = await db.specialty.findMany({
    where: { isActive: true, category: { isActive: true } },
    select: { id: true, nameAr: true, nameEn: true, slug: true, description: true, categoryId: true, category: { select: { nameAr: true, nameEn: true, slug: true, description: true } } },
    orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }],
  });
  const specs: Spec[] = rows.map(r => ({
    id: r.id, name: r.nameAr ?? '', nameEn: r.nameEn ?? '', slug: r.slug ?? '', description: r.description ?? '',
    categoryId: r.categoryId, categoryName: r.category?.nameAr ?? '', categoryNameEn: r.category?.nameEn ?? '', categorySlug: r.category?.slug ?? '', categoryDescription: r.category?.description ?? '',
  }));
  if (specs.length === 0) return NONE;
  const byId = new Map(specs.map(s => [s.id, s]));
  const result = (source: ClientRecommendationSource, reason: ClientRecommendationReason, message: string, categoryId: string, chosen: Spec[], confidence: number | null): ClientSpecialtyRecommendation => ({
    hasRecommendation: true, source, reason, message, categoryId, categoryName: specs.find(s => s.categoryId === categoryId)!.categoryName,
    specialtyIds: chosen.map(s => s.id), specialtyNames: chosen.map(s => s.name), confidence,
  });

  // 1) the text the client typed
  const text = String(rawText ?? '').slice(0, MAX_RECOMMENDATION_TEXT);
  const tokens = [...new Set(wordsOf(text).filter(w => w.length >= 3 && !STOP.has(w)))];
  if (tokens.length > 0) {
    const specScore = new Map<string, number>();
    const catScore = new Map<string, number>();
    const matched = new Set<string>();
    for (const t of tokens) {
      for (const s of specs) {
        let sc = 0;
        if (hits(t, s.name) || hits(t, s.nameEn) || hits(t, s.slug.replace(/-/g, ' '))) sc += 3;
        else if (hits(t, s.description)) sc += 1;
        if (sc) { specScore.set(s.id, (specScore.get(s.id) ?? 0) + sc); matched.add(t); }
      }
      const seenCats = new Set<string>();
      for (const s of specs) {
        if (seenCats.has(s.categoryId)) continue;
        seenCats.add(s.categoryId);
        let sc = 0;
        if (hits(t, s.categoryName) || hits(t, s.categoryNameEn) || hits(t, s.categorySlug.replace(/-/g, ' '))) sc += 3;
        else if (hits(t, s.categoryDescription)) sc += 1;
        if (sc) { catScore.set(s.categoryId, (catScore.get(s.categoryId) ?? 0) + sc); matched.add(t); }
      }
    }
    const total = new Map<string, number>(catScore);
    for (const [id, sc] of specScore) { const cid = byId.get(id)!.categoryId; total.set(cid, (total.get(cid) ?? 0) + sc); }
    const ranked = [...total.entries()].filter(([, sc]) => sc >= 2).sort((a, b) => b[1] - a[1]);
    if (ranked.length > 0) {
      const [cid] = ranked[0];
      const chosen = specs.filter(s => s.categoryId === cid && (specScore.get(s.id) ?? 0) >= 3).sort((a, b) => (specScore.get(b.id)! - specScore.get(a.id)!)).slice(0, 5);
      const catName = specs.find(s => s.categoryId === cid)!.categoryName;
      return result('text_match', 'TEXT_MATCH', `ما كتبته يطابق «${catName}»${chosen.length ? ` وتخصصات مثل «${chosen[0].name}»` : ''}.`, cid, chosen, Math.round((matched.size / tokens.length) * 100) / 100);
    }
  }

  // 2) the client's own earlier requests
  const mine = await db.clientRequest.findMany({ where: { clientProfile: { userId }, status: { not: 'DRAFT' } }, select: { specialtyId: true } });
  const mineBySpec = new Map<string, number>();
  for (const r of mine) { if (byId.has(r.specialtyId)) mineBySpec.set(r.specialtyId, (mineBySpec.get(r.specialtyId) ?? 0) + 1); }
  if (mineBySpec.size > 0) {
    const perCat = new Map<string, number>();
    for (const [id, n] of mineBySpec) { const cid = byId.get(id)!.categoryId; perCat.set(cid, (perCat.get(cid) ?? 0) + n); }
    const [cid, n] = [...perCat.entries()].sort((a, b) => b[1] - a[1])[0];
    const chosen = [...mineBySpec.entries()].filter(([id]) => byId.get(id)!.categoryId === cid).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => byId.get(id)!);
    const catName = specs.find(s => s.categoryId === cid)!.categoryName;
    return result('client_history', 'CLIENT_HISTORY', `أرسلتَ ${n === 1 ? 'طلبًا سابقًا واحدًا' : `${n} طلبات سابقة`} في «${catName}».`, cid, chosen, null);
  }

  // 3) platform demand
  const groups = await db.clientRequest.groupBy({ by: ['specialtyId'], where: { status: 'OPEN' }, _count: { _all: true } });
  const openBySpec = new Map<string, number>();
  const openByCat = new Map<string, number>();
  for (const g of groups) {
    const s = byId.get(g.specialtyId); const n = g._count?._all ?? 0;
    if (!s || n <= 0) continue;
    openBySpec.set(s.id, n); openByCat.set(s.categoryId, (openByCat.get(s.categoryId) ?? 0) + n);
  }
  if (openByCat.size > 0) {
    const [cid, n] = [...openByCat.entries()].sort((a, b) => b[1] - a[1])[0];
    const chosen = specs.filter(s => s.categoryId === cid && openBySpec.has(s.id)).sort((a, b) => openBySpec.get(b.id)! - openBySpec.get(a.id)!).slice(0, 3);
    const catName = specs.find(s => s.categoryId === cid)!.categoryName;
    return result('popular', 'OPEN_DEMAND', `«${catName}» هو الأكثر طلبًا على المنصة حاليًا (${n} ${n === 1 ? 'طلب مفتوح' : 'طلبات مفتوحة'}).`, cid, chosen, null);
  }

  return NONE;
}

export const clientSpecialtyRecommendationService = {
  recommend: (userId: string, text?: string) => computeClientSpecialtyRecommendation(prisma as unknown as ClientRecommendationDb, userId, text),
};
