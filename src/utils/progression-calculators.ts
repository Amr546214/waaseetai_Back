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
// The ladders themselves live in ONE place: config/levels.config.ts (names, thresholds, percentages, colours). The matrices below are views of it
// in the shape the existing importers expect; nothing here is a second copy of a number.
import { PROVIDER_LEVELS, CLIENT_LEVELS } from '../config/levels.config';

// مقدم الخدمة — commission DECREASES as the level rises (loyalty reward).
export const PROVIDER_LEVEL_MATRIX = PROVIDER_LEVELS.map(d => ({
  index: d.level, title: d.name, reqPoints: d.minPoints, reqProjects: d.minProjects, reqRating: d.minRating, commission: d.percent
}));

// طالب الخدمة — `rate` is CASHBACK %, and it INCREASES with the level.
export const REQUESTER_LEVEL_MATRIX = CLIENT_LEVELS.map(d => ({
  index: d.level, title: d.name, reqPoints: d.minPoints, reqProjects: d.minProjects, reqRating: d.minRating, rate: d.percent
}));

// (The broker ladder is MARKETER_LEVELS in config/levels.config.ts; the commission engine reads it through config/affiliate-levels.config.ts.)

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


export interface RequesterProgressionInput {
  points: number;
  completedProjects: number;
  avgRating: number;
}

export interface RequesterProgressionResult {
  currentLevelIndex: number;
  currentLevelTitle: string;
  currentCashbackPercent: number;
  pointsToNextLevel: number;
}

/** Same rule as the provider's: the highest level whose points AND projects AND rating thresholds are all met (>=). */
export function deriveRequesterProgression(input: RequesterProgressionInput): RequesterProgressionResult {
  const points = Math.max(0, input.points || 0);
  const completedProjects = Math.max(0, input.completedProjects || 0);
  const avgRating = Math.max(0, input.avgRating || 0);
  let current = REQUESTER_LEVEL_MATRIX[0];
  for (let i = REQUESTER_LEVEL_MATRIX.length - 1; i >= 0; i--) {
    const level = REQUESTER_LEVEL_MATRIX[i];
    if (points >= level.reqPoints && completedProjects >= level.reqProjects && avgRating >= level.reqRating) { current = level; break; }
  }
  const next = REQUESTER_LEVEL_MATRIX.find(l => l.index === Math.min(current.index + 1, REQUESTER_LEVEL_MATRIX.length)) || current;
  return { currentLevelIndex: current.index, currentLevelTitle: current.title, currentCashbackPercent: current.rate, pointsToNextLevel: Math.max(0, next.reqPoints - points) };
}
