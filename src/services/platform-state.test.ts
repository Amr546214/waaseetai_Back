import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

async function load(t: TestContext, st: { trusted: { value: boolean; trusted: boolean; stale: boolean }; text: string }) {
	t.mock.module('./system-settings.service', { namedExports: { systemSettingsService: { getTrusted: async () => st.trusted, get: async () => st.text, publicSnapshot: async () => ({data:{maintenanceMode:st.trusted.value,maintenanceBannerText:st.text},revision:7,trusted:st.trusted.trusted}) } } });
	return import(`./platform-state?m=${Math.random()}`);
}

test('public platform state: ON carries the saved message (or the default when empty); OFF carries no message; never anything but on/message/at', async (t: TestContext) => {
	const st = { trusted: { value: true, trusted: true, stale: false }, text: ' نعود الساعة 5 ' };
	const { publicPlatformState } = await load(t, st);
	const on = await publicPlatformState(); assert.equal(on.maintenance.on, true); assert.equal(on.maintenance.message, 'نعود الساعة 5'); assert.deepEqual(Object.keys(on).sort(), ['at', 'maintenance', 'revision']);
	st.text = ''; assert.match((await publicPlatformState()).maintenance.message, /صيانة مؤقتة/);
	st.trusted = { value: false, trusted: true, stale: false }; const off = await publicPlatformState(); assert.deepEqual(off.maintenance, { on: false, message: '' });
});

test('broadcast: one `platform:state` event to every open socket, and nothing when there is no server', async (t: TestContext) => {
	const { broadcastPlatformState, PLATFORM_STATE_EVENT } = await load(t, { trusted: { value: true, trusted: true, stale: false }, text: 'x' });
	const sent: any[] = []; await broadcastPlatformState({ emit: (e: string, p: any) => sent.push([e, p]) } as any); await broadcastPlatformState(null);
	assert.equal(sent.length, 1); assert.equal(sent[0][0], PLATFORM_STATE_EVENT); assert.equal(sent[0][1].maintenance.on, true);
});
