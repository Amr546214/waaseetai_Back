import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRequesterProgression } from './progression-calculators';

// Level 4 «عميل» needs points >= 301, projects >= 9 and a rating >= 4.0 (config/levels.config.ts CLIENT_LEVELS). A client with no ratings has avgRating null (NOT 0, NOT invented).
const lvl = (points: number, completedProjects: number, avgRating: number | null) => deriveRequesterProgression({ points, completedProjects, avgRating });

test('promotion boundaries: every threshold is inclusive and each one alone holds the client back', () => {
	assert.equal(lvl(301, 9, 4.0).currentLevelIndex, 4);
	assert.equal(lvl(300, 9, 4.0).currentLevelIndex, 3, 'one point short');
	assert.equal(lvl(301, 8, 4.0).currentLevelIndex, 3, 'one project short');
	assert.equal(lvl(301, 9, 3.99).currentLevelIndex, 3, 'rating just below 4.0');
	assert.equal(lvl(301, 9, 4.0).currentCashbackPercent, 2.5);
	assert.equal(lvl(7201, 116, 4.9).currentLevelIndex, 15); assert.equal(lvl(7201, 116, 4.89).currentLevelIndex, 14, 'top level needs 4.9');
});

test('NO ratings is not a rating of zero and is never invented: levels above the first stay out of reach, the first level does not need a rating', () => {
	const none = lvl(7201, 116, null);
	assert.equal(none.currentLevelIndex, 1, 'points and projects alone never promote a client with no ratings'); assert.equal(none.ratingBasis, 'NO_RATINGS');
	assert.equal(lvl(0, 0, null).currentLevelIndex, 1);
	const zero = lvl(7201, 116, 0); assert.equal(zero.currentLevelIndex, 1); assert.equal(zero.ratingBasis, 'RATED', 'an actual rating of 0 is a rating');
	assert.equal(lvl(7201, 116, Number.NaN as any).ratingBasis, 'NO_RATINGS', 'a non-number is no rating');
	// a client WITH a real rating is promoted by the same points / projects
	assert.equal(lvl(7201, 116, 5).currentLevelIndex, 15);
});
