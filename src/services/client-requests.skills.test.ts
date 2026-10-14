import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// requiredSkills of a client request are validated against the catalog of the chosen specialty's Category (same source as providers' skills).
process.env.JWT_SECRET = 'test-secret';

function setup(t: TestContext) {
	const created: any[] = [];
	const prisma: any = {
		clientProfile: { findUnique: async () => ({ id: 'cp1', userId: 'u1' }) },
		user: { findUnique: async () => ({ id: 'u1' }) },
		specialty: { findUnique: async () => ({ id: 'sp1', categoryId: 'c1', nameAr: 'تطوير' }), findFirst: async () => null },
		category: { findUnique: async () => ({ slug: 'programming-development' }) },
		clientRequest: { create: async (a: any) => { created.push(a.data); throw new Error('STOP_AFTER_CREATE'); } }
	};
	t.mock.module('../config/db', { namedExports: { prisma } });
	return created;
}
const dto = (over: any = {}) => ({ specialtyId: 'sp1', title: 'طلب موقع', description: 'وصف طويل للمشروع هنا', minBudget: 100, expectedDurationDays: 7, budgetType: 'FIXED', subSpecialties: ['واجهات'], requiredSkills: [], ...over });
const run = async (over: any) => { const { clientRequestsService } = await import(`./client-requests.service.ts?f=${Date.now()}-${Math.random()}`); return clientRequestsService.createRequest('u1', dto(over) as any); };

test('invalid requiredSkills: 400 listing the offenders and nothing is saved', async (t) => {
	const created = setup(t);
	await assert.rejects(() => run({ requiredSkills: ['React', 'مهارة وهمية', 'AutoCAD'] }), (e: any) => e.statusCode === 400 && /مهارة وهمية/.test(e.message) && /AutoCAD/.test(e.message));
	assert.equal(created.length, 0);
});

test('valid requiredSkills (catalog of the specialty category) reach the saved request, trimmed and de-duplicated', async (t) => {
	const created = setup(t);
	await assert.rejects(() => run({ requiredSkills: [' React ', 'Node.js', 'React'] }), /STOP_AFTER_CREATE/);
	assert.deepEqual(created[0].requiredSkills, ['React', 'Node.js']);
});

test('empty requiredSkills keeps the existing fallback to the sub-specialties', async (t) => {
	const created = setup(t);
	await assert.rejects(() => run({ requiredSkills: [] }), /STOP_AFTER_CREATE/);
	assert.deepEqual(created[0].requiredSkills, ['واجهات']);
});
