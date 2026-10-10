import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_LEVELS, CLIENT_LEVELS, MARKETER_LEVELS, levelColor, levelStation, levelDef, publicLevelsPayload, clampLevel } from './levels.config';
import { PROVIDER_LEVEL_MATRIX, REQUESTER_LEVEL_MATRIX, LEVEL_MATRIX, deriveProviderProgression, deriveRequesterProgression } from '../utils/progression-calculators';
import { PROVIDER_FEE_TABLE, REQUESTER_CASHBACK_PERCENT, affiliateCommission, cashback, providerWithdrawalFees } from '../utils/fee-policy';
import { AFFILIATE_LEVEL_RATES, AFFILIATE_LEVEL_NAMES, resolveAffiliateCommissionPercentage } from './affiliate-levels.config';

// The expected tables are typed out here ON PURPOSE (a copy of the workbook "نظام النقاط و الولاء.xlsx", sheet المستويات): the config must equal them.
const PROVIDER = {
  names: ['مبتدئ', 'منجز', 'منفذ', 'بارع', 'متقن', 'متمكن', 'أخصائي', 'محترف', 'خبير', 'رصين', 'مستشار', 'رائد', 'مراجع', 'مبتكر', 'مرجع'],
  points: [0, 101, 251, 451, 701, 1001, 1501, 2201, 3001, 4001, 5001, 6501, 8001, 10001, 12001],
  projects: [0, 3, 6, 11, 16, 21, 30, 46, 61, 81, 101, 126, 151, 181, 211],
  rating: [0, 3.5, 3.8, 4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.5, 4.5, 4.6, 4.7, 4.8, 4.9],
  commission: [5, 4.8, 4.6, 4.4, 4.2, 4, 3.75, 3.5, 3.25, 3, 2.75, 2.5, 2, 1.5, 1],
};
const CLIENT = {
  names: ['زائر', 'مستكشف', 'باحث', 'عميل', 'داعم', 'ناشط', 'فعال', 'راعي', 'سفير', 'استراتيجي', 'أساسي', 'مالك', 'مؤسس', 'دائم', 'مؤسسي'],
  points: [0, 51, 151, 301, 501, 751, 1101, 1501, 2001, 2601, 3301, 4101, 5001, 6001, 7201],
  projects: [0, 2, 5, 9, 13, 17, 23, 31, 41, 51, 61, 73, 86, 101, 116],
  rating: [0, 3.5, 3.8, 4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.5, 4.5, 4.6, 4.7, 4.8, 4.9],
  cashback: [1, 1.5, 2, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 4.2, 4.4, 4.6, 4.8, 5],
};
const MARKETER = {
  names: ['مسوق', 'مساعد', 'موصل', 'منسق', 'وسيط', 'ممثل', 'سفير', 'موجه', 'حلقة وصل', 'جسر الوصل', 'ناقل حيوي', 'موصل استراتيجي', 'رابط استشاري', 'شريك تنفيذي', 'رابط مؤسسي'],
  points: [0, 101, 251, 451, 701, 1001, 1501, 2201, 3001, 4001, 5001, 6501, 8001, 10001, 12001],
  clients: [0, 4, 8, 13, 19, 26, 36, 51, 71, 96, 126, 161, 201, 251, 301],
  revenue: [0, 501, 1501, 3001, 5001, 8001, 12001, 20001, 35001, 60001, 100001, 150001, 250001, 400001, 600001],
  // level 7 keeps 2.75 until the owner confirms (the workbook prints 3.75, which is above level 8's 3.0)
  commission: [1, 1.2, 1.5, 2, 2.25, 2.5, 2.75, 3, 3.2, 3.4, 3.6, 3.8, 4, 4.3, 4.5],
};

test('PROVIDER ladder = the workbook: 15 names, thresholds (points, projects, rating) and the commission (5% down to 1%)', () => {
  assert.equal(PROVIDER_LEVELS.length, 15);
  assert.deepEqual(PROVIDER_LEVELS.map(l => l.name), PROVIDER.names);
  assert.deepEqual(PROVIDER_LEVELS.map(l => l.minPoints), PROVIDER.points);
  assert.deepEqual(PROVIDER_LEVELS.map(l => l.minProjects), PROVIDER.projects);
  assert.deepEqual(PROVIDER_LEVELS.map(l => l.minRating), PROVIDER.rating);
  assert.deepEqual(PROVIDER_LEVELS.map(l => l.percent), PROVIDER.commission);
});
test('CLIENT ladder = the workbook: 15 names, thresholds and the cashback (1% up to 5%)', () => {
  assert.deepEqual(CLIENT_LEVELS.map(l => l.name), CLIENT.names);
  assert.deepEqual(CLIENT_LEVELS.map(l => l.minPoints), CLIENT.points);
  assert.deepEqual(CLIENT_LEVELS.map(l => l.minProjects), CLIENT.projects);
  assert.deepEqual(CLIENT_LEVELS.map(l => l.minRating), CLIENT.rating);
  assert.deepEqual(CLIENT_LEVELS.map(l => l.percent), CLIENT.cashback);
});
test('MARKETER ladder = the workbook: 15 names, thresholds (points, clients, revenue) and the commission', () => {
  assert.deepEqual(MARKETER_LEVELS.map(l => l.name), MARKETER.names);
  assert.deepEqual(MARKETER_LEVELS.map(l => l.minPoints), MARKETER.points);
  assert.deepEqual(MARKETER_LEVELS.map(l => l.minProjects), MARKETER.clients);
  assert.deepEqual(MARKETER_LEVELS.map(l => l.minRevenue), MARKETER.revenue);
  assert.deepEqual(MARKETER_LEVELS.map(l => l.percent), MARKETER.commission);
  assert.equal(MARKETER_LEVELS[6].pendingOwnerConfirmation !== undefined, true, 'level 7 is flagged as pending the owner');
});
test('direction of the money: provider commission only goes down, client cashback and marketer commission only go up (marketer: from level 8 on, level 7 is pending)', () => {
  for (let i = 1; i < 15; i++) {
    assert.ok(PROVIDER_LEVELS[i].percent < PROVIDER_LEVELS[i - 1].percent, `provider ${i + 1}`);
    assert.ok(CLIENT_LEVELS[i].percent > CLIENT_LEVELS[i - 1].percent, `client ${i + 1}`);
    if (i !== 7) assert.ok(MARKETER_LEVELS[i].percent > MARKETER_LEVELS[i - 1].percent, `marketer ${i + 1}`);
  }
});

// ── ONE source: nothing else carries a copy ──
test('every consumer reads the single ladder: progression matrices, fee policy, affiliate config (no second copy of a number or a name)', () => {
  assert.deepEqual(PROVIDER_LEVEL_MATRIX.map(l => [l.title, l.reqPoints, l.reqProjects, l.reqRating, l.commission]), PROVIDER_LEVELS.map(l => [l.name, l.minPoints, l.minProjects, l.minRating, l.percent]));
  assert.equal(LEVEL_MATRIX, PROVIDER_LEVEL_MATRIX);
  assert.deepEqual(REQUESTER_LEVEL_MATRIX.map(l => [l.title, l.reqPoints, l.reqProjects, l.reqRating, l.rate]), CLIENT_LEVELS.map(l => [l.name, l.minPoints, l.minProjects, l.minRating, l.percent]));
  assert.deepEqual(PROVIDER_FEE_TABLE.map(r => r.platform), PROVIDER_LEVELS.map(l => l.percent));
  assert.deepEqual([...REQUESTER_CASHBACK_PERCENT], CLIENT_LEVELS.map(l => l.percent));
  for (const l of MARKETER_LEVELS) { assert.equal(AFFILIATE_LEVEL_RATES[l.level], l.percent); assert.equal(AFFILIATE_LEVEL_NAMES[l.level], l.name); assert.equal(affiliateCommission(l.level), l.percent); }
});
test('the fee schedule\'s other columns are untouched (admin / transfer / VAT / total as published) and the money helpers follow the ladder', () => {
  assert.deepEqual(PROVIDER_FEE_TABLE[0], { level: 1, platform: 5, admin: 2, transfer: 5, vat: 0.75, total: 12.75 });
  assert.deepEqual(PROVIDER_FEE_TABLE[14], { level: 15, platform: 1, admin: 5, transfer: 2, vat: 0.15, total: 8.15 });
  assert.equal(providerWithdrawalFees(15, 1000).percent.platform, 1);
  assert.equal(cashback(15, 1000, 1), 50);       // 5% of 1000
  assert.equal(cashback(1, 1000, 1), 10);        // 1% of 1000
  assert.equal(resolveAffiliateCommissionPercentage(15), 4.5);
  assert.equal(resolveAffiliateCommissionPercentage(0), 1, 'out-of-range falls back to level 1, never 0 / NaN');
});

// ── level selection at the boundaries (every threshold is `>=`; ALL of them must be met) ──
test('PROVIDER selection: exactly at a boundary is IN, one short on any single threshold is OUT', () => {
  for (const l of PROVIDER_LEVELS) {
    const at = deriveProviderProgression({ points: l.minPoints, completedProjects: l.minProjects, avgRating: l.minRating });
    assert.equal(at.currentLevelIndex, l.level, `at level ${l.level}`);
    assert.equal(at.currentCommission, l.percent);
    if (l.level > 1) {
      assert.ok(deriveProviderProgression({ points: l.minPoints - 1, completedProjects: l.minProjects, avgRating: l.minRating }).currentLevelIndex < l.level, `points short ${l.level}`);
      assert.ok(deriveProviderProgression({ points: l.minPoints, completedProjects: l.minProjects - 1, avgRating: l.minRating }).currentLevelIndex < l.level, `projects short ${l.level}`);
      assert.ok(deriveProviderProgression({ points: l.minPoints, completedProjects: l.minProjects, avgRating: Number((l.minRating - 0.01).toFixed(2)) }).currentLevelIndex < l.level, `rating short ${l.level}`);
    }
  }
  const p = deriveProviderProgression({ points: 101, completedProjects: 3, avgRating: 3.5 });
  assert.deepEqual([p.currentLevelIndex, p.currentLevelTitle, p.currentCommission, p.pointsToNextLevel], [2, 'منجز', 4.8, 150]);
  assert.equal(deriveProviderProgression({ points: 100, completedProjects: 3, avgRating: 3.5 }).currentLevelIndex, 1, '100 points is still level 1 (the level starts AT 101)');
  assert.equal(deriveProviderProgression({ points: 999999, completedProjects: 999, avgRating: 5 }).currentLevelIndex, 15);
  assert.equal(deriveProviderProgression({ points: 999999, completedProjects: 999, avgRating: 5 }).pointsToNextLevel, 0);
});
test('PROVIDER demotion exists only as the live recompute: a rating that falls below the level minimum lowers the level at the next event (no scheduled downgrade is implemented)', () => {
  const before = deriveProviderProgression({ points: 1501, completedProjects: 30, avgRating: 4.3 });
  const after = deriveProviderProgression({ points: 1501, completedProjects: 30, avgRating: 4.29 });
  assert.equal(before.currentLevelIndex, 7);
  assert.equal(after.currentLevelIndex, 6);
  assert.ok(after.currentCommission > before.currentCommission, 'a lower level means a higher commission');
});
test('CLIENT selection: boundaries, promotion, and the cashback of the level reached', () => {
  const at = (l: typeof CLIENT_LEVELS[number]) => deriveRequesterProgression({ points: l.minPoints, completedProjects: l.minProjects, avgRating: l.minRating });
  for (const l of CLIENT_LEVELS) { const r = at(l); assert.equal(r.currentLevelIndex, l.level); assert.equal(r.currentCashbackPercent, l.percent); assert.equal(r.currentLevelTitle, l.name); }
  assert.equal(deriveRequesterProgression({ points: 50, completedProjects: 2, avgRating: 3.5 }).currentLevelIndex, 1, '50 points is still level 1 (level 2 starts AT 51)');
  assert.equal(deriveRequesterProgression({ points: 51, completedProjects: 1, avgRating: 3.5 }).currentLevelIndex, 1, 'one project short');
  assert.equal(deriveRequesterProgression({ points: 0, completedProjects: 0, avgRating: 0 }).currentCashbackPercent, 1);
  assert.equal(deriveRequesterProgression({ points: 7201, completedProjects: 116, avgRating: 4.9 }).pointsToNextLevel, 0);
});

// ── colours / public payload ──
test('colours: 5 stations of 3 levels per role, from the brand formula (hue, saturation, lightness)', () => {
  for (const [lvl, st] of [[1, 1], [3, 1], [4, 2], [6, 2], [7, 3], [9, 3], [10, 4], [12, 4], [13, 5], [15, 5]] as const) assert.equal(levelStation(lvl), st);
  assert.equal(levelColor('PROVIDER', 1, 'dark'), '#94DEF9');
  assert.equal(levelColor('PROVIDER', 15, 'dark'), '#0913A5');
  assert.equal(levelColor('PROVIDER', 15, 'light'), '#07108D');
  assert.equal(levelColor('CLIENT', 1, 'dark'), '#97F7C7');
  assert.equal(levelColor('CLIENT', 15, 'light'), '#0B7089');
  assert.equal(levelColor('MARKETER', 1, 'dark'), '#FBAF93');
  assert.equal(levelColor('MARKETER', 8, 'dark'), '#F5A314');
  assert.equal(levelColor('PROVIDER', 4, 'dark'), levelColor('PROVIDER', 6, 'dark'), 'same station, same colour');
  assert.notEqual(levelColor('PROVIDER', 3, 'dark'), levelColor('PROVIDER', 4, 'dark'));
  assert.notEqual(levelColor('PROVIDER', 4, 'dark'), levelColor('CLIENT', 4, 'dark'), 'each role has its own hue family');
});
test('GET /levels payload: 15 levels x 3 roles with names, percent kind, thresholds and colours; nothing per-user', () => {
  const p: any = publicLevelsPayload();
  assert.equal(p.thresholdRule, 'GREATER_OR_EQUAL');
  assert.deepEqual(Object.keys(p.roles), ['PROVIDER', 'CLIENT', 'MARKETER']);
  assert.deepEqual([p.roles.PROVIDER.percentKind, p.roles.CLIENT.percentKind, p.roles.MARKETER.percentKind], ['COMMISSION', 'CASHBACK', 'COMMISSION']);
  for (const r of ['PROVIDER', 'CLIENT', 'MARKETER']) assert.equal(p.roles[r].levels.length, 15);
  assert.deepEqual(p.roles.PROVIDER.levels[1], { level: 2, name: 'منجز', percent: 4.8, station: 1, color: { dark: levelColor('PROVIDER', 2, 'dark'), light: levelColor('PROVIDER', 2, 'light') }, thresholds: { points: 101, projects: 3, rating: 3.5 } });
  assert.deepEqual(p.roles.MARKETER.levels[1].thresholds, { points: 101, clients: 4, revenueUsd: 501 });
  assert.equal(p.roles.MARKETER.levels[6].pendingOwnerConfirmation, true);
  assert.equal(JSON.stringify(p).includes('userId'), false);
});
test('clampLevel / levelDef never go out of range', () => {
  assert.equal(clampLevel(0), 1); assert.equal(clampLevel(99), 15); assert.equal(clampLevel(2.5), 1);
  assert.equal(levelDef('CLIENT', 99).name, 'مؤسسي');
});
