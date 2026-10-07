import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// #25 — a service's title, description, sub-specialty and stages' title/description are stored as plain text (markup stripped).
process.env.OPENAI_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';
const X = (w: string) => `<img src=x onerror=alert(1)><b>${w}</b><script></script>`;
const stage = (over: any = {}) => ({ title: X('تحليل'), description: X('وصف المرحلة'), percentage: 100, deliveryDays: 5, computedAmount: 100, ...over });

test('sanitizeServiceInput strips markup from every free-text field and leaves other fields alone', async () => {
	const { sanitizeServiceInput } = await mod();
	const out = sanitizeServiceInput({ title: X('خدمة تصميم'), description: X('وصف طويل للخدمة'), subSpecialty: X('شعارات'), totalAmount: 5, stages: [stage(), stage({ description: undefined, desc: X('بديل') })] });
	assert.deepEqual([out.title, out.description, out.subSpecialty], ['خدمة تصميم', 'وصف طويل للخدمة', 'شعارات']);
	assert.deepEqual([out.stages[0].title, out.stages[0].description], ['تحليل', 'وصف المرحلة']);
	assert.equal(out.stages[1].desc, 'بديل');
	assert.equal(out.stages[0].percentage, 100);
	assert.equal(out.totalAmount, 5);
});

test('lengths are capped and non-string values are left to the validators', async () => {
	const { sanitizeServiceInput } = await mod();
	const out = sanitizeServiceInput({ title: 'x'.repeat(400), description: 123, stages: 'nope' });
	assert.equal(out.title.length, 150);
	assert.equal(out.description, 123);
	assert.equal(out.stages, 'nope');
	assert.equal(sanitizeServiceInput(null), null);
});

test('markup-only title is judged as empty by the existing validation (create is refused)', async () => {
	const svc = new (await mod()).MarketplaceService();
	await assert.rejects(() => svc.createService('u1', { title: '<b></b>', description: 'وصف طويل بما يكفي للخدمة', stages: [stage()] }), /Title and description are required/);
});

// service-level: what reaches prisma.create
const created: any[] = [];
let loaded: Promise<any> | undefined;
function load() {
	loaded ??= (async () => {
		const tx: any = { serviceCatalog: { create: async (a: any) => { created.push(a.data); return { id: 's1', ...a.data, stages: [] }; }, update: async (a: any) => { created.push(a.data); return { id: 's1', ...a.data, stages: [] }; } }, serviceStage: { deleteMany: async () => ({}) } };
		const prisma: any = {
			providerSpecialty: { findFirst: async () => ({ id: 'ps1', specialty: { id: 'sp1' } }) },
			accreditationSample: { findFirst: async () => ({ id: 'as1' }) },
			portfolioItem: { findFirst: async () => null },
			serviceCatalog: { findFirst: async () => ({ id: 's1', providerId: 'u1', approvedAt: new Date(), totalAmount: 100, totalDays: 5 }) },
			$transaction: async (fn: any) => fn(tx),
		};
		mock.module('../config/db', { namedExports: { prisma } });
		mock.module('../config/logger', { namedExports: { logger: { error() {}, info() {}, warn() {}, debug() {} } } });
		mock.module('./marketplace-ai.service', { namedExports: { marketplaceAiService: {} } });
		mock.module('./ai-audit.service', { namedExports: { aiAuditService: { auditProjectModel: async () => {} } } });
		return await import('./marketplace-service.service.ts');
	})();
	return loaded;
}
const mod = () => load() as Promise<any>;

test('createService / updateService store plain text only (title, description, sub-specialty, stage title and description)', async () => {
	const svc = new (await mod()).MarketplaceService();
	created.length = 0;
	const body = { title: X('خدمة تصميم'), description: X('وصف طويل للخدمة هنا'), subSpecialty: X('شعارات'), specialtyId: 'sp1', accreditationSampleId: 'as1', stages: [stage()] };
	await svc.createService('u1', body);
	await svc.updateService('u1', 's1', body);
	assert.equal(created.length, 2);
	for (const data of created) {
		assert.deepEqual([data.title, data.description, data.subSpecialty], ['خدمة تصميم', 'وصف طويل للخدمة هنا', 'شعارات']);
		assert.deepEqual([data.stages.create[0].title, data.stages.create[0].description], ['تحليل', 'وصف المرحلة']);
		assert.doesNotMatch(JSON.stringify(data), /<script|<img|<b>|onerror/);
	}
});
