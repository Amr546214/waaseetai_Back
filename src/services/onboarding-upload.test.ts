import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// AUD-FND-000043 — POST /auth/onboarding/upload must save the document in the onboarding record only; User.idDocumentUrl (which the
// profile-completion calculation reads) is written when the reviewer APPROVES the document, never at upload time.

type Row = { id: string; userId: string; status: string; documentUrl: string; documentName: string; documentType: string };
const state: { row: Row | null; userUpdates: any[]; profileUpdates: any[] } = { row: null, userUpdates: [], profileUpdates: [] };
const prisma: any = {
	clientOnboarding: {
		upsert: async ({ create }: any) => { state.row = { id: 'o1', ...create }; return { ...state.row }; },
		findUnique: async () => (state.row ? { ...state.row, user: { id: 'u1', firstName: 'a', lastName: 'b', email: 'e', phoneNumber: 'p', idDocumentUrl: null }, clientProfile: null } : null),
		findMany: async () => (state.row ? [{ ...state.row, createdAt: new Date(), user: {} }] : []),
		count: async () => (state.row ? 1 : 0),
		update: async ({ data }: any) => { state.row = { ...state.row!, ...data }; return { ...state.row }; },
	},
	user: { update: async (a: any) => { state.userUpdates.push(a); return {}; }, findUnique: async () => ({ id: 'u1', idDocumentUrl: null }) },
	clientProfile: { updateMany: async (a: any) => { state.profileUpdates.push(a); return { count: 1 }; }, findUnique: async () => null },
	$transaction: async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(prisma)),
};

let loaded: Promise<any> | undefined;
function service() {
	loaded ??= (async () => {
		mock.module('../config/db', { namedExports: { prisma } });
		return (await import('./onboarding.service')).onboardingService;
	})();
	return loaded;
}
function reset(row: Row | null = null) { state.row = row; state.userUpdates = []; state.profileUpdates = []; }
const URL_A = 'https://res.example/a.jpg';

test('upload saves the document in client_onboarding (PENDING) and does NOT write User.idDocumentUrl', async () => {
	reset();
	const svc = await service();
	const rec = await svc.saveUpload('u1', { documentType: 'NATIONAL_ID', documentUrl: URL_A, documentName: 'id.jpg' });
	assert.equal(rec.status, 'PENDING');
	assert.equal(rec.documentUrl, URL_A);
	assert.equal(state.userUpdates.length, 0, 'the profile document field must not be written before approval');
});

test('approval writes User.idDocumentUrl from the record and verifies the client profile (admin path still works)', async () => {
	reset({ id: 'o1', userId: 'u1', status: 'PENDING', documentUrl: URL_A, documentName: 'id.jpg', documentType: 'NATIONAL_ID' });
	const svc = await service();
	const out = await svc.approveOnboarding('o1');
	assert.equal(out.status, 'APPROVED');
	assert.deepEqual(state.userUpdates.map(u => u.data), [{ idDocumentUrl: URL_A }]);
	assert.equal(state.profileUpdates[0].data.kycStatus, 'VERIFIED');
});

test('rejection never writes the profile document field', async () => {
	reset({ id: 'o1', userId: 'u1', status: 'PENDING', documentUrl: URL_A, documentName: 'id.jpg', documentType: 'NATIONAL_ID' });
	const svc = await service();
	await svc.rejectOnboarding('o1', { rejectionReason: 'صورة غير واضحة' });
	assert.equal(state.userUpdates.length, 0);
	assert.equal(state.profileUpdates[0].data.kycStatus, 'REJECTED');
});

test('the admin list and detail endpoints still return the onboarding record', async () => {
	reset({ id: 'o1', userId: 'u1', status: 'PENDING', documentUrl: URL_A, documentName: 'id.jpg', documentType: 'NATIONAL_ID' });
	const svc = await service();
	const list = await svc.listOnboarding('PENDING', 1, 10);
	assert.ok(JSON.stringify(list).includes('o1'));
	const one = await svc.getOnboarding('o1');
	assert.equal(one.documentUrl, URL_A);
});
