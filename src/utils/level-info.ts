// ONE level display payload for every role, built only from config/levels.config.ts (name, percent, colour pair, station). Every page that shows a level
// (dashboards, level pages, public profile, badges) receives this shape, so a level never has to be rebuilt from a stale label.
import { LEVELS_BY_ROLE, clampLevel, levelColor, levelStation, type LevelRole } from '../config/levels.config';

export interface LevelInfo {
	role: LevelRole;
	index: number;
	total: number;
	name: string;
	/** commission % (provider: the platform commission, marketer: the earned commission) or cashback % (client) */
	percent: number;
	percentKind: 'PLATFORM_COMMISSION' | 'EARNED_COMMISSION' | 'CASHBACK';
	station: number;
	color: { dark: string; light: string };
}

const KIND: Record<LevelRole, LevelInfo['percentKind']> = { PROVIDER: 'PLATFORM_COMMISSION', MARKETER: 'EARNED_COMMISSION', CLIENT: 'CASHBACK' };

export function levelInfo(role: LevelRole, index: number | null | undefined): LevelInfo {
	const level = clampLevel(Number.isFinite(index as number) && (index as number) >= 1 ? Math.floor(index as number) : 1);
	const def = LEVELS_BY_ROLE[role][level - 1];
	return {
		role, index: level, total: LEVELS_BY_ROLE[role].length, name: def.name, percent: def.percent, percentKind: KIND[role], station: levelStation(level),
		color: { dark: levelColor(role, level, 'dark'), light: levelColor(role, level, 'light') },
	};
}
