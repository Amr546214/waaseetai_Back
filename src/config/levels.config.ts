// THE single source of truth for the three 15-level ladders (provider / client / marketer): names, qualification thresholds, the per-level percentage
// and the level colours. Everything else (progression calculators, the fee policy, the affiliate commission engine, the public /levels API and,
// through it, the UI) reads THIS file; no other file may carry a level name or a level percentage.
//
// Source (the ONLY one, owner correction): the two workbooks "نظام النقاط و الولاء.xlsx" (sheet المستويات: names, thresholds, commission / cashback)
// and "نسب الدفع.xlsx" (provider final deduction by level, client deposit fees, marketer withdrawal fees). Earlier identity images, the PDF and the
// 3%-18% marketer table are NOT used. Threshold semantics: a level is reached when EVERY threshold is met with `>=` (workbook formula
// AND(points>=D, projects>=E, rating>=F)). Percentages: provider = platform commission (decreases: 12.75% -> 8.15%); client = CASHBACK (increases:
// 1% -> 5%); marketer = COMMISSION (increases: 1% -> 4.5%; level 7 = 2.75% exactly as the workbook).
//
// NOT here: downgrade rules and the points-earning events for clients and marketers (not defined in the workbooks).

export type LevelRole = 'PROVIDER' | 'CLIENT' | 'MARKETER';

export interface LevelDef {
  level: number;
  name: string;
  /** commission % (provider, marketer) or cashback % (client) */
  percent: number;
  minPoints: number;
  /** provider / client: completed projects; marketer: active referred clients */
  minProjects: number;
  /** provider / client only: average rating (stars) */
  minRating: number;
  /** marketer only: total referred revenue in USD */
  minRevenue: number;
  /** set when the value is kept pending an owner confirmation */
  pendingOwnerConfirmation?: string;
}

const L = (level: number, name: string, percent: number, minPoints: number, minProjects: number, minRating: number, minRevenue = 0, pendingOwnerConfirmation?: string): LevelDef =>
  ({ level, name, percent, minPoints, minProjects, minRating, minRevenue, ...(pendingOwnerConfirmation ? { pendingOwnerConfirmation } : {}) });

// مقدم الخدمة — the platform commission (= the FINAL deduction, "الخصم النهائي لمقدمي الخدمات" in نسب الدفع.xlsx: no other fee is added on top)
// DECREASES as the level rises: 12.75% at level 1 down to 8.15% at level 15.
export const PROVIDER_LEVELS: readonly LevelDef[] = [
  L(1, 'مبتدئ', 12.75, 0, 0, 0), L(2, 'منجز', 12.42, 101, 3, 3.5),
  L(3, 'منفذ', 12.1, 251, 6, 3.8), L(4, 'بارع', 11.77, 451, 11, 4.0),
  L(5, 'متقن', 11.45, 701, 16, 4.1), L(6, 'متمكن', 11.12, 1001, 21, 4.2),
  L(7, 'أخصائي', 10.8, 1501, 30, 4.3), L(8, 'محترف', 10.47, 2201, 46, 4.4),
  L(9, 'خبير', 10.15, 3001, 61, 4.5), L(10, 'رصين', 9.82, 4001, 81, 4.5),
  L(11, 'مستشار', 9.5, 5001, 101, 4.5), L(12, 'رائد', 9.17, 6501, 126, 4.6),
  L(13, 'مراجع', 8.85, 8001, 151, 4.7), L(14, 'مبتكر', 8.52, 10001, 181, 4.8),
  L(15, 'مرجع', 8.15, 12001, 211, 4.9),
];

// طالب الخدمة — cashback INCREASES with the level.
export const CLIENT_LEVELS: readonly LevelDef[] = [
  L(1, 'زائر', 1.0, 0, 0, 0), L(2, 'مستكشف', 1.5, 51, 2, 3.5), L(3, 'باحث', 2.0, 151, 5, 3.8), L(4, 'عميل', 2.5, 301, 9, 4.0),
  L(5, 'داعم', 2.75, 501, 13, 4.1), L(6, 'ناشط', 3.0, 751, 17, 4.2), L(7, 'فعال', 3.25, 1101, 23, 4.3), L(8, 'راعي', 3.5, 1501, 31, 4.4),
  L(9, 'سفير', 3.75, 2001, 41, 4.5), L(10, 'استراتيجي', 4.0, 2601, 51, 4.5), L(11, 'أساسي', 4.2, 3301, 61, 4.5), L(12, 'مالك', 4.4, 4101, 73, 4.6),
  L(13, 'مؤسس', 4.6, 5001, 86, 4.7), L(14, 'دائم', 4.8, 6001, 101, 4.8), L(15, 'مؤسسي', 5.0, 7201, 116, 4.9),
];

// الوسيط / المسوق — commission INCREASES with the level (flat per-level rate; the level selects the percentage, it is never itself payable).
export const MARKETER_LEVELS: readonly LevelDef[] = [
  L(1, 'مسوق', 1.0, 0, 0, 0, 0), L(2, 'مساعد', 1.2, 101, 4, 0, 501), L(3, 'موصل', 1.5, 251, 8, 0, 1501), L(4, 'منسق', 2.0, 451, 13, 0, 3001),
  L(5, 'وسيط', 2.25, 701, 19, 0, 5001), L(6, 'ممثل', 2.5, 1001, 26, 0, 8001),
  L(7, 'سفير', 2.75, 1501, 36, 0, 12001),
  L(8, 'موجه', 3.0, 2201, 51, 0, 20001), L(9, 'حلقة وصل', 3.2, 3001, 71, 0, 35001), L(10, 'جسر الوصل', 3.4, 4001, 96, 0, 60001),
  L(11, 'ناقل حيوي', 3.6, 5001, 126, 0, 100001), L(12, 'موصل استراتيجي', 3.8, 6501, 161, 0, 150001), L(13, 'رابط استشاري', 4.0, 8001, 201, 0, 250001),
  L(14, 'شريك تنفيذي', 4.3, 10001, 251, 0, 400001), L(15, 'رابط مؤسسي', 4.5, 12001, 301, 0, 600001),
];

export const LEVELS_BY_ROLE: Readonly<Record<LevelRole, readonly LevelDef[]>> = { PROVIDER: PROVIDER_LEVELS, CLIENT: CLIENT_LEVELS, MARKETER: MARKETER_LEVELS };
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 15;

// ── colours: 5 "stations" of 3 consecutive levels per role (brand identity: hsl(hue, saturation, lightness)) ──
export const LEVEL_STATION_HUES: Readonly<Record<LevelRole, readonly number[]>> = {
  PROVIDER: [196, 206, 216, 226, 236],
  CLIENT: [150, 162, 172, 182, 192],
  MARKETER: [16, 28, 38, 46, 54],
};
export const LEVEL_SATURATION: Readonly<Record<LevelRole, number>> = { PROVIDER: 90, CLIENT: 85, MARKETER: 92 };
export const LEVEL_LIGHTNESS = { dark: [78, 64, 52, 42, 34], light: [56, 48, 40, 34, 29] } as const;

/** 1..15 -> station 1..5 (levels 1-3, 4-6, 7-9, 10-12, 13-15 share a colour). */
export const levelStation = (level: number): number => Math.min(5, Math.max(1, Math.ceil(clampLevel(level) / 3)));

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100, lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = lig - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

export function levelColor(role: LevelRole, level: number, theme: 'dark' | 'light' = 'dark'): string {
  const station = levelStation(level);
  return hslToHex(LEVEL_STATION_HUES[role][station - 1], LEVEL_SATURATION[role], LEVEL_LIGHTNESS[theme][station - 1]);
}

export function clampLevel(level: number): number {
  return Number.isInteger(level) ? Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, level)) : MIN_LEVEL;
}

export const levelDef = (role: LevelRole, level: number): LevelDef => LEVELS_BY_ROLE[role][clampLevel(level) - 1];

/** The public, read-only shape served by GET /levels (and consumed by the UI): nothing secret, nothing computed per user. */
export function publicLevelsPayload() {
  const kind = { PROVIDER: 'COMMISSION', CLIENT: 'CASHBACK', MARKETER: 'COMMISSION' } as const;
  const label = { PROVIDER: 'مقدم الخدمة', CLIENT: 'طالب الخدمة', MARKETER: 'الوسيط' } as const;
  return {
    version: 1,
    thresholdRule: 'GREATER_OR_EQUAL',
    roles: (Object.keys(LEVELS_BY_ROLE) as LevelRole[]).reduce((acc, role) => {
      acc[role] = {
        label: label[role],
        percentKind: kind[role],
        levels: LEVELS_BY_ROLE[role].map(d => ({
          level: d.level, name: d.name, percent: d.percent, station: levelStation(d.level),
          color: { dark: levelColor(role, d.level, 'dark'), light: levelColor(role, d.level, 'light') },
          thresholds: role === 'MARKETER'
            ? { points: d.minPoints, clients: d.minProjects, revenueUsd: d.minRevenue }
            : { points: d.minPoints, projects: d.minProjects, rating: d.minRating },
          ...(d.pendingOwnerConfirmation ? { pendingOwnerConfirmation: true } : {}),
        })),
      };
      return acc;
    }, {} as Record<LevelRole, unknown>),
  };
}
