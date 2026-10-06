import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

async function load(t: TestContext, analyzeProject: (...a: any[]) => Promise<any>) {
	const calls: any[] = [];
	t.mock.module('./ai/waseet-ai/waseet-ai.client', { namedExports: { waseetAiClient: { analyzeProject: async (...a: any[]) => { calls.push(a); return analyzeProject(...a); } } } });
	const mod = await import(`./client-request-analysis.ts?f=${Date.now()}-${Math.random()}`);
	return { mod, calls };
}
const input = { title: 'موقع', description: 'وصف تفصيلي للمشروع', budget: 500, deadlineDays: 14 };

test('success: summary is the vendor executiveSummary; complexity stays null (no vendor field)', async (t) => {
	const { mod, calls } = await load(t, async () => ({ clarityScore: 80, feasibilityScore: 70, marketFitRating: 'HIGH', executiveSummary: '  ملخص حقيقي  ', strengths: [], gapsAndRisks: [] }));
	assert.deepEqual(await mod.analyzeNewRequest(input), { aiAnalyzedSummary: 'ملخص حقيقي', aiComplexityRating: null });
	assert.deepEqual(calls[0][0], { title: 'موقع', description: 'وصف تفصيلي للمشروع', budget: 500, deadlineDays: 14, currency: 'USD' });
	assert.equal(calls[0][1].timeoutMs, 8000);
});

test('vendor failure: both fields null and nothing throws (request creation is never blocked)', async (t) => {
	const { mod } = await load(t, async () => { throw new Error('boom'); });
	assert.deepEqual(await mod.analyzeNewRequest(input), { aiAnalyzedSummary: null, aiComplexityRating: null });
});

test('no numeric budget: no vendor call is made and fields are null', async (t) => {
	const { mod, calls } = await load(t, async () => ({}));
	assert.deepEqual(await mod.analyzeNewRequest({ ...input, budget: null }), { aiAnalyzedSummary: null, aiComplexityRating: null });
	assert.equal(calls.length, 0);
});

test('readAiAnalysis: null when no real analysis; legacy template + constant LOW are not presented as AI output', async (t) => {
	const { mod } = await load(t, async () => ({}));
	assert.equal(mod.readAiAnalysis(null, null), null);
	assert.equal(mod.readAiAnalysis('طلب مشروع "x" في تخصص برمجة. الميزانية المقدرة: 100 - 200 $.', 'LOW'), null);
	assert.deepEqual(mod.readAiAnalysis('ملخص', null), { summary: 'ملخص', complexityRating: null });
});
