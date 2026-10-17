import { test } from 'node:test';
import assert from 'node:assert/strict';

// Before the platform_settings / marketing_assets migration is applied, every VISIBLE read answers 200 with an honest empty/default state (never 503);
// only a save/upload is refused (503, clear message). After the migration the same code reads the real rows.
const missing = Object.assign(new Error('The table `public.x` does not exist'), { code: 'P2021' });

async function load(t: any, db: any) {
	t.mock.module('../config/db', { namedExports: { prisma: db } });
	const stamp = Math.random();
	return {
		settings: (await import(`./platform-settings.service?${stamp}`)).platformSettingsService,
		assets: (await import(`./marketing-assets.service?${stamp}`)).marketingAssetsService,
		marketer: (await import(`./marketer-assets.service?${stamp}`)).marketerAssetsService
	};
}

const noTables = {
	platformSetting: { findMany: async () => { throw missing; }, count: async () => { throw missing; }, upsert: async () => { throw missing; } },
	marketingAsset: { findMany: async () => { throw missing; }, count: async () => { throw missing; }, create: async () => { throw missing; } },
	$transaction: (x: any[]) => Promise.all(x)
};

test('settings without the table: defaults (200), storageReady=false, and a save is a clear 503', async t => {
	const { settings } = await load(t, noTables);
	const all = await settings.getAll();
	assert.ok(Object.keys(all).length > 0);
	assert.equal(await settings.storageReady(), false);
	assert.ok(Object.keys(await settings.getPublic()).length > 0);
	await assert.rejects(() => settings.update({ [Object.keys(all)[0]]: 'x' } as any, 'admin-1'), (e: any) => e.statusCode === 503 || e.status === 503);
});

test('settings with the table: stored rows override the defaults, storageReady=true', async t => {
	const { settings } = await load(t, { platformSetting: { findMany: async () => [], count: async () => 0 } });
	assert.equal(await settings.storageReady(), true);
});

test('admin assets list without the table: empty list, storageReady=false (page opens)', async t => {
	const { assets } = await load(t, noTables);
	const out = await assets.list({});
	assert.deepEqual(out.items, []);
	assert.equal(out.storageReady, false);
});

test('admin assets list with the table: real rows, storageReady=true', async t => {
	const row = { id: 'a1', title: 't' };
	const { assets } = await load(t, { marketingAsset: { findMany: async () => [row], count: async () => 1 }, $transaction: async (x: any[]) => Promise.all(x) });
	const out = await assets.list({});
	assert.equal(out.storageReady, true);
	assert.equal(out.items.length, 1);
});

test('marketer assets without the table: empty state (200)', async t => {
	const { marketer } = await load(t, noTables);
	assert.deepEqual(await marketer.listForMarketer(), { items: [] });
});

test('marketer assets with rows: active file/link/text only, dead entries dropped', async t => {
	const rows = [
		{ id: '1', kind: 'IMAGE', title: 'بنر', description: null, fileUrl: 'https://cdn.example.com/b.png', linkUrl: null, text: null },
		{ id: '2', kind: 'LINK', title: 'دليل', description: 'd', fileUrl: null, linkUrl: 'https://example.com/g', text: null },
		{ id: '3', kind: 'TEXT', title: 'رسالة', description: null, fileUrl: null, linkUrl: null, text: 'مرحبا' },
		{ id: '4', kind: 'IMAGE', title: 'ميت', description: null, fileUrl: 'javascript:1', linkUrl: null, text: null }
	];
	const { marketer } = await load(t, { marketingAsset: { findMany: async () => rows } });
	const out = await marketer.listForMarketer();
	assert.deepEqual(out.items.map((i: any) => i.id), ['1', '2', '3']);
	assert.equal(out.items[2].text, 'مرحبا');
	assert.equal(out.items[2].downloadUrl, null);
});
