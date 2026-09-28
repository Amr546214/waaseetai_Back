import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveProviderProgression, LEVEL_MATRIX } from './progression-calculators';

// Phase 3D.3A: deriveProviderProgression is a pure function (no Prisma, no
// DB, no dotenv, no service imports with side effects), so these tests run
// with zero mocking. It is a verbatim port of gamification.service.ts's
// existing getLevelDetails() in-memory level-selection loop — a 3-dimensional
// qualification (points AND completedProjects AND avgRating, all inclusive
// >=), never a points-only shortcut.

test('0 points / 0 projects / 0 rating -> level 1', () => {
  const result = deriveProviderProgression({ points: 0, completedProjects: 0, avgRating: 0 });
  assert.equal(result.currentLevelIndex, 1);
  assert.equal(result.currentLevelTitle, 'مبتدئ');
  assert.equal(result.currentCommission, 5.0);
});

test('exact level-2 threshold on all 3 dimensions qualifies (inclusive >=)', () => {
  const level2 = LEVEL_MATRIX[1];
  const result = deriveProviderProgression({
    points: level2.reqPoints,
    completedProjects: level2.reqProjects,
    avgRating: level2.reqRating
  });
  assert.equal(result.currentLevelIndex, 2);
  assert.equal(result.currentLevelTitle, 'منجز');
});

test('points threshold met but completedProjects threshold not met -> falls back to previous level', () => {
  const level2 = LEVEL_MATRIX[1];
  const result = deriveProviderProgression({
    points: level2.reqPoints,
    completedProjects: level2.reqProjects - 1,
    avgRating: level2.reqRating
  });
  assert.equal(result.currentLevelIndex, 1);
});

test('points and completedProjects met but avgRating threshold not met -> falls back to previous level', () => {
  const level2 = LEVEL_MATRIX[1];
  const result = deriveProviderProgression({
    points: level2.reqPoints,
    completedProjects: level2.reqProjects,
    avgRating: level2.reqRating - 0.1
  });
  assert.equal(result.currentLevelIndex, 1);
});

test('between thresholds -> resolves to the highest fully-qualified level, not the highest points alone would suggest', () => {
  // Way more points than level 5 needs, but far short of level 5's project/rating requirements.
  const level5 = LEVEL_MATRIX[4];
  const result = deriveProviderProgression({
    points: level5.reqPoints + 10000,
    completedProjects: 1,
    avgRating: 3.0
  });
  // Only level 1 (0/0/0) is satisfied by completedProjects=1, avgRating=3.0.
  assert.equal(result.currentLevelIndex, 1);
});

test('exact later-level threshold (level 7) qualifies', () => {
  const level7 = LEVEL_MATRIX[6];
  const result = deriveProviderProgression({
    points: level7.reqPoints,
    completedProjects: level7.reqProjects,
    avgRating: level7.reqRating
  });
  assert.equal(result.currentLevelIndex, 7);
  assert.equal(result.currentLevelTitle, 'أخصائي');
});

test('max level -> pointsToNextLevel is 0', () => {
  const maxLevel = LEVEL_MATRIX[LEVEL_MATRIX.length - 1];
  const result = deriveProviderProgression({
    points: maxLevel.reqPoints,
    completedProjects: maxLevel.reqProjects,
    avgRating: maxLevel.reqRating
  });
  assert.equal(result.currentLevelIndex, maxLevel.index);
  assert.equal(result.pointsToNextLevel, 0);
});

test('values above max -> resolves to max level, not an out-of-bounds index', () => {
  const maxLevel = LEVEL_MATRIX[LEVEL_MATRIX.length - 1];
  const result = deriveProviderProgression({
    points: maxLevel.reqPoints + 100000,
    completedProjects: maxLevel.reqProjects + 100,
    avgRating: 5.0
  });
  assert.equal(result.currentLevelIndex, maxLevel.index);
  assert.equal(result.pointsToNextLevel, 0);
});

test('negative points/projects/rating safely normalize to 0 instead of crashing or going negative', () => {
  const result = deriveProviderProgression({ points: -50, completedProjects: -3, avgRating: -1 });
  assert.equal(result.currentLevelIndex, 1);
  assert.equal(result.currentLevelTitle, 'مبتدئ');
  assert.equal(result.pointsToNextLevel, LEVEL_MATRIX[1].reqPoints);
});

test('currentCommission matches the selected LEVEL_MATRIX entry exactly', () => {
  const level9 = LEVEL_MATRIX[8];
  const result = deriveProviderProgression({
    points: level9.reqPoints,
    completedProjects: level9.reqProjects,
    avgRating: level9.reqRating
  });
  assert.equal(result.currentLevelIndex, 9);
  assert.equal(result.currentCommission, level9.commission);
});

test('pointsToNextLevel matches the next level\'s reqPoints gap, never guaranteeing promotion from points alone', () => {
  const level3 = LEVEL_MATRIX[2];
  const level4 = LEVEL_MATRIX[3];
  // Provider qualifies exactly for level 3 on all 3 dimensions.
  const result = deriveProviderProgression({
    points: level3.reqPoints,
    completedProjects: level3.reqProjects,
    avgRating: level3.reqRating
  });
  assert.equal(result.currentLevelIndex, 3);
  assert.equal(result.pointsToNextLevel, level4.reqPoints - level3.reqPoints);
});

test('a huge points surplus alone does not shrink pointsToNextLevel below what the qualified level actually is', () => {
  // Confirms pointsToNextLevel is computed from the QUALIFIED level, not from
  // whatever level the raw points number alone would reach.
  const level5 = LEVEL_MATRIX[4];
  const level6 = LEVEL_MATRIX[5];
  const result = deriveProviderProgression({
    points: level6.reqPoints + 50000, // enough points for level 6 and beyond
    completedProjects: level5.reqProjects, // but projects only clear level 5
    avgRating: level5.reqRating
  });
  assert.equal(result.currentLevelIndex, 5);
  assert.equal(result.pointsToNextLevel, Math.max(0, level6.reqPoints - (level6.reqPoints + 50000)));
  assert.equal(result.pointsToNextLevel, 0); // already has more points than level 6 needs, but is NOT level 6
});
