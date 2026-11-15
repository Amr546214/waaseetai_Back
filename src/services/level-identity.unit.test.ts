import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyLevelOverrides, defaultLevelColor, defaultLevelName, levelColor, LEVELS_BY_ROLE, publicLevelsPayload } from '../config/levels.config';
import { levelInfo } from '../utils/level-info';
import { AFFILIATE_LEVEL_NAMES } from '../config/affiliate-levels.config';
import { applyChanges, parseOverrides } from './level-identity.service';

afterEach(() => applyLevelOverrides({}));

test('a published name and colour reach every reader: levelInfo, the public /levels payload, the level object and the marketer name map; percentages never move', () => {
	const before = levelInfo('MARKETER', 3).percent;
	applyLevelOverrides(applyChanges({}, [{ role: 'MARKETER', level: 3, name: 'موصل ذهبي', dark: '#12ab34', light: '#223344' }]));
	const info = levelInfo('MARKETER', 3);
	assert.equal(info.name, 'موصل ذهبي'); assert.deepEqual(info.color, { dark: '#12AB34', light: '#223344' }); assert.equal(info.percent, before);
	const pub = publicLevelsPayload().roles as Record<string, { levels: Array<{ level: number; name: string; color: { dark: string } }> }>;
	assert.equal(pub.MARKETER.levels[2].name, 'موصل ذهبي'); assert.equal(pub.MARKETER.levels[2].color.dark, '#12AB34'); assert.equal(pub.MARKETER.levels[3].name, 'منسق');
	assert.equal(LEVELS_BY_ROLE.MARKETER[2].name, 'موصل ذهبي'); assert.equal(AFFILIATE_LEVEL_NAMES[3], 'موصل ذهبي');
	assert.equal(levelColor('MARKETER', 4, 'dark'), defaultLevelColor('MARKETER', 4, 'dark'), 'other levels keep the brand colour');
});
test('null / empty puts a field back to the default and an all-default level leaves no override', () => {
	const a = applyChanges({}, [{ role: 'CLIENT', level: 2, name: 'مستكشف جديد', dark: '#AA0000' }]);
	const b = applyChanges(a, [{ role: 'CLIENT', level: 2, name: null, dark: null }]);
	assert.deepEqual(b, {}); applyLevelOverrides(b);
	assert.equal(levelInfo('CLIENT', 2).name, defaultLevelName('CLIENT', 2)); assert.equal(levelInfo('CLIENT', 2).color.dark, defaultLevelColor('CLIENT', 2, 'dark'));
});
test('invalid values are refused with the field: bad colour, empty-looking symbols, too long, unknown role / level, markup', () => {
	const bad = (c: unknown) => assert.throws(() => applyChanges({}, [c]), /./);
	bad({ role: 'PROVIDER', level: 1, dark: 'red' }); bad({ role: 'PROVIDER', level: 1, dark: '#12345' }); bad({ role: 'PROVIDER', level: 1, name: '<b>x</b>' });
	bad({ role: 'PROVIDER', level: 1, name: 'ا'.repeat(25) }); bad({ role: 'ADMIN', level: 1, name: 'x' }); bad({ role: 'PROVIDER', level: 16, name: 'x' }); bad({ role: 'PROVIDER', level: 0, name: 'x' }); bad({ role: 'PROVIDER', level: 1.5, name: 'x' });
	assert.throws(() => applyChanges({}, []), /./); assert.throws(() => applyChanges({}, 'x'), /./);
});
test('two levels of one ladder cannot share a name (also against the untouched defaults); the same name on another ladder is fine', () => {
	assert.throws(() => applyChanges({}, [{ role: 'PROVIDER', level: 2, name: 'مبتدئ' }]), /مستعمل/);
	assert.throws(() => applyChanges({}, [{ role: 'PROVIDER', level: 1, name: 'خبير' }]), /مستعمل/);
	assert.doesNotThrow(() => applyChanges({}, [{ role: 'CLIENT', level: 1, name: 'مبتدئ' }]));
	assert.doesNotThrow(() => applyChanges({}, [{ role: 'PROVIDER', level: 1, name: 'خبير' }, { role: 'PROVIDER', level: 9, name: 'خبير جديد' }]));
});
test('a stored row with junk is parsed to the valid part only (a hand-edited row can never put markup or a bad colour on the site)', () => {
	const o = parseOverrides({ PROVIDER: { '1': { name: '<script>', dark: '#ZZZZZZ', light: '#abcdef' }, '99': { name: 'x' } }, BOGUS: { '1': { name: 'x' } }, CLIENT: { '2': { name: 'اسم سليم' } } });
	assert.deepEqual(o, { PROVIDER: { '1': { light: '#ABCDEF' } }, CLIENT: { '2': { name: 'اسم سليم' } } });
	assert.deepEqual(parseOverrides(null), {}); assert.deepEqual(parseOverrides('x'), {});
});

test('the level matrices (level page, roadmap, progression results) follow a published rename at once: titles are live, a spread copy taken per request is current, a reset restores the workbook name', async () => {
	const { PROVIDER_LEVEL_MATRIX, REQUESTER_LEVEL_MATRIX, deriveProviderProgression } = await import('../utils/progression-calculators');
	const first = applyChanges({}, [{ role: 'PROVIDER', level: 1, name: 'فلاح' }, { role: 'CLIENT', level: 1, name: 'ضيف' }]);
	applyLevelOverrides(first);
	assert.equal(PROVIDER_LEVEL_MATRIX[0].title, 'فلاح'); assert.equal(REQUESTER_LEVEL_MATRIX[0].title, 'ضيف');
	assert.equal(({ ...PROVIDER_LEVEL_MATRIX[0] }).title, 'فلاح', 'the roadmap spreads each level per request');
	assert.equal(JSON.parse(JSON.stringify(PROVIDER_LEVEL_MATRIX[0])).title, 'فلاح', 'and the title is serialised');
	assert.equal((deriveProviderProgression({ points: 0, completedProjects: 0, avgRating: 0 } as any) as any).currentLevelTitle, 'فلاح');
	applyLevelOverrides({});
	assert.equal(PROVIDER_LEVEL_MATRIX[0].title, defaultLevelName('PROVIDER', 1)); assert.equal(PROVIDER_LEVEL_MATRIX[1].title, defaultLevelName('PROVIDER', 2));
});
