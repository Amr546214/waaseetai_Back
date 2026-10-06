// Phase 3D.3A: a pure, side-effect-free provider-progression calculator.
// No Prisma imports, no dotenv, no DB, no service imports with side effects —
// takes already-fetched plain numbers and returns a derived level, so this
// can be unit-tested without ever loading db.ts.
//
// LEVEL_MATRIX itself now lives here (moved out of gamification.service.ts,
// which re-exports it unchanged for its existing importers —
// role-display-resolver.ts and provider-profile.service.ts both still import
// it as `from '../services/gamification.service'`, untouched). This is a
// straight relocation, not a values change: it exists here, instead of being
// imported from gamification.service.ts, purely to avoid a circular import
// (gamification.service.ts needs deriveProviderProgression from this file;
// this file needs LEVEL_MATRIX — one of the two had to own the array).
// Brand identity §10 defines THREE separate 15-level ladders — one per role —
// with different names and different rate semantics. The app previously had a
// single matrix that carried the REQUESTER names (زائر/مستكشف/باحث…) while
// being used exclusively for PROVIDERS, which is why provider cards in the
// marketplace were labelled "زائر". Names and rates below are verbatim from
// the brand doc; the qualification thresholds (reqPoints/reqProjects/
// reqRating) are the app's existing, already-live gates — the brand doc does
// not specify per-role gates, so those are deliberately left unchanged so
// this stays a naming/rate alignment and not a re-gating of progression.

// مقدم الخدمة — commission DECREASES as the level rises (loyalty reward).
export const PROVIDER_LEVEL_MATRIX = [
  { index: 1, title: 'مبتدئ', reqPoints: 0, reqProjects: 0, reqRating: 0.0, commission: 5.0 },
  { index: 2, title: 'منجز', reqPoints: 50, reqProjects: 2, reqRating: 3.5, commission: 4.8 },
  { index: 3, title: 'منفذ', reqPoints: 150, reqProjects: 5, reqRating: 3.8, commission: 4.6 },
  { index: 4, title: 'بارع', reqPoints: 300, reqProjects: 9, reqRating: 4.0, commission: 4.4 },
  { index: 5, title: 'متقن', reqPoints: 501, reqProjects: 13, reqRating: 4.1, commission: 4.2 },
  { index: 6, title: 'متمكن', reqPoints: 751, reqProjects: 20, reqRating: 4.2, commission: 4.0 },
  { index: 7, title: 'أخصائي', reqPoints: 1101, reqProjects: 30, reqRating: 4.3, commission: 3.75 },
  { index: 8, title: 'محترف', reqPoints: 1501, reqProjects: 42, reqRating: 4.4, commission: 3.5 },
  { index: 9, title: 'خبير', reqPoints: 2001, reqProjects: 55, reqRating: 4.5, commission: 3.25 },
  { index: 10, title: 'رصين', reqPoints: 2601, reqProjects: 70, reqRating: 4.6, commission: 3.0 },
  { index: 11, title: 'مستشار', reqPoints: 3301, reqProjects: 85, reqRating: 4.7, commission: 2.75 },
  { index: 12, title: 'رائد', reqPoints: 4101, reqProjects: 100, reqRating: 4.8, commission: 2.5 },
  { index: 13, title: 'مراجع', reqPoints: 5001, reqProjects: 115, reqRating: 4.85, commission: 2.0 },
  { index: 14, title: 'مبتكر', reqPoints: 6001, reqProjects: 130, reqRating: 4.9, commission: 1.5 },
  { index: 15, title: 'مرجع', reqPoints: 7201, reqProjects: 150, reqRating: 4.9, commission: 1.0 }
];

// طالب الخدمة — `rate` is CASHBACK %, and it INCREASES with the level.
// Point thresholds are the brand doc's own requester thresholds.
export const REQUESTER_LEVEL_MATRIX = [
  { index: 1, title: 'زائر', reqPoints: 0, rate: 0.0 },
  { index: 2, title: 'مستكشف', reqPoints: 51, rate: 1.5 },
  { index: 3, title: 'باحث', reqPoints: 151, rate: 2.0 },
  { index: 4, title: 'عميل', reqPoints: 301, rate: 2.5 },
  { index: 5, title: 'داعم', reqPoints: 501, rate: 2.75 },
  { index: 6, title: 'ناشط', reqPoints: 751, rate: 3.0 },
  { index: 7, title: 'فعال', reqPoints: 1101, rate: 3.25 },
  { index: 8, title: 'راعي', reqPoints: 1501, rate: 3.5 },
  { index: 9, title: 'سفير', reqPoints: 2001, rate: 3.75 },
  { index: 10, title: 'استراتيجي', reqPoints: 2601, rate: 4.0 },
  { index: 11, title: 'أساسي', reqPoints: 3301, rate: 4.2 },
  { index: 12, title: 'مالك', reqPoints: 4101, rate: 4.4 },
  { index: 13, title: 'مؤسس', reqPoints: 5001, rate: 4.6 },
  { index: 14, title: 'دائم', reqPoints: 6001, rate: 4.8 },
  { index: 15, title: 'مؤسسي', reqPoints: 7201, rate: 5.0 }
];

// (The unused broker matrix was removed: it was imported nowhere and disagreed with the binding fee table. The live broker rates are
// AFFILIATE_LEVEL_RATES in config/affiliate-levels.config.ts.)

// Every existing importer of LEVEL_MATRIX resolves a PROVIDER's level
// (marketplace cards, provider profile, cart checkout, gamification), so the
// legacy name stays pointed at the provider ladder.
export const LEVEL_MATRIX = PROVIDER_LEVEL_MATRIX;

export interface ProviderProgressionInput {
  points: number;
  completedProjects: number;
  avgRating: number;
}

export interface ProviderProgressionResult {
  currentLevelIndex: number;
  currentLevelTitle: string;
  currentCommission: number;
  pointsToNextLevel: number;
}

/**
 * Verbatim port of gamification.service.ts#getLevelDetails's in-memory level
 * selection loop — same 3-dimensional qualification (points AND
 * completedProjects AND avgRating, all inclusive >=), same "highest fully
 * qualified level wins" rule, same LEVEL_MATRIX. This is a consistency fix,
 * not a redesign: it does not convert the system to points-only progression,
 * and it does not invent new thresholds.
 *
 * pointsToNextLevel is ONLY the points gap to the next matrix entry after the
 * currently-qualified level — it never implies that points alone would
 * unlock that next level while the project/rating requirements remain unmet.
 *
 * Unexpected negative inputs are floored to 0 before qualification (the
 * existing getLevelDetails loop only avoided this by accident of variable
 * initialization order — this makes the floor explicit instead of relying on
 * that).
 */
export function deriveProviderProgression(input: ProviderProgressionInput): ProviderProgressionResult {
  const points = Math.max(0, input.points || 0);
  const completedProjects = Math.max(0, input.completedProjects || 0);
  const avgRating = Math.max(0, input.avgRating || 0);

  let currentLevel = LEVEL_MATRIX[0];
  for (let i = LEVEL_MATRIX.length - 1; i >= 0; i--) {
    const level = LEVEL_MATRIX[i];
    if (points >= level.reqPoints && completedProjects >= level.reqProjects && avgRating >= level.reqRating) {
      currentLevel = level;
      break;
    }
  }

  const maxIndex = LEVEL_MATRIX[LEVEL_MATRIX.length - 1].index;
  const nextLevelIndex = Math.min(currentLevel.index + 1, maxIndex);
  const nextLevel = LEVEL_MATRIX.find(level => level.index === nextLevelIndex) || currentLevel;

  const pointsToNextLevel = Math.max(0, nextLevel.reqPoints - points);

  return {
    currentLevelIndex: currentLevel.index,
    currentLevelTitle: currentLevel.title,
    currentCommission: currentLevel.commission,
    pointsToNextLevel
  };
}
