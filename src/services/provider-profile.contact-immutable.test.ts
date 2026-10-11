import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// A contact change that was requested BEFORE the e-mail/phone became immutable can never be confirmed or applied.
process.env.JWT_SECRET = 'test-secret';
process.env.OPENAI_API_KEY = 'test-key';

async function load(t: TestContext) {
  const updates: any[] = [];
  const userWrites: any[] = [];
  const empty = new Proxy({}, { get: (_m, method: string) => async () => (method === 'count' ? 0 : method === 'findMany' ? [] : null) });
  const prisma: any = new Proxy({}, { get: (target: any, model: string) => target[model] ?? empty });
  prisma.profileModificationRequest = {
    findFirst: async () => ({ id: 'req-1', providerId: 'p1', status: 'PENDING_OTP', category: 'CONTACT', metadata: { changes: { email: 'x@y.co', phoneNumber: '1025073026' } } }),
    update: async (a: any) => { updates.push(a); return {}; },
  };
  prisma.user = { update: async (a: any) => { userWrites.push(a); return {}; } };
  t.mock.module('../config/db', { namedExports: { prisma } });
  const { providerProfileService } = await import(`./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { providerProfileService, updates, userWrites };
}

test('an old CONTACT request still waiting for its code is closed (CANCELLED) and never applied, whatever code is sent', async (t) => {
  const { providerProfileService, updates, userWrites } = await load(t);
  await assert.rejects(() => providerProfileService.verifySensitiveChange('p1', 'req-1', '123456'), /CONTACT_IMMUTABLE/);
  assert.deepEqual(updates.map(u => [u.where.id, u.data.status]), [['req-1', 'CANCELLED']]);
  assert.equal(userWrites.length, 0);
});

test('the controller answers 403 with the CONTACT_IMMUTABLE code and the Arabic display-only message for every contact-change entry point', async (t) => {
  const { providerProfileService } = await load(t);
  const ctrl = await import(`../controllers/provider-profile.controller.ts?fixture=${Date.now()}-${Math.random()}`);
  const call = async (fn: string, body: any) => {
    let status = 0; let json: any;
    const res: any = { status(c: number) { status = c; return res; }, json(b: any) { json = b; return res; } };
    await (ctrl as any)[fn]({ user: { id: 'p1' }, body, params: {}, headers: {}, ip: '127.0.0.1', get: () => '' } as any, res);
    return { status, json };
  };
  void providerProfileService;
  for (const [fn, body] of [['initiateSensitiveChange', { category: 'CONTACT', changes: { email: 'a@b.co' } }], ['updateContactInfo', { email: 'a@b.co' }], ['createModificationRequest', { fieldName: 'PHONE_NUMBER', fieldLabel: 'x', requestedValue: '0511111111' }], ['verifySensitiveChange', { requestId: 'req-1', code: '123456' }]] as const) {
    const r = await call(fn, body);
    assert.equal(r.status, 403, `${fn}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.code, 'CONTACT_IMMUTABLE', fn);
    assert.match(r.json.message, /للعرض فقط/, fn);
  }
});
