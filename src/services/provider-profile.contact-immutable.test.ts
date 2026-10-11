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

// ── WhatsApp: the one editable contact number, a DIRECT save (no code, no request, no review) ──
async function loadWhatsapp(t: TestContext) {
  const userUpdates: any[] = []; const requestWrites: any[] = [];
  const empty = new Proxy({}, { get: (_m, method: string) => async () => (method === 'count' ? 0 : method === 'findMany' ? [] : null) });
  const prisma: any = new Proxy({}, { get: (target: any, model: string) => target[model] ?? empty });
  prisma.user = { update: async (a: any) => { userUpdates.push(a.data); return { alternativePhone: a.data.alternativePhone }; } };
  prisma.profileModificationRequest = { create: async (a: any) => { requestWrites.push(a); return {}; } };
  t.mock.module('../config/db', { namedExports: { prisma } });
  const { providerProfileService } = await import(`./provider-profile.service.ts?fixture=${Date.now()}-${Math.random()}`);
  return { providerProfileService, userUpdates, requestWrites };
}

test('WhatsApp: a valid number is saved directly (separators stripped), with no request, no code and no review', async (t) => {
  const { providerProfileService, userUpdates, requestWrites } = await loadWhatsapp(t);
  const r = await providerProfileService.updateWhatsapp('p1', '+20 102-507 3026');
  assert.equal(r.alternativePhone, '+201025073026');
  assert.deepEqual(userUpdates, [{ alternativePhone: '+201025073026' }]);
  assert.equal(requestWrites.length, 0);
});

test('WhatsApp: empty clears it; an invalid number is refused (INVALID_WHATSAPP) and nothing is written', async (t) => {
  const { providerProfileService, userUpdates } = await loadWhatsapp(t);
  assert.equal((await providerProfileService.updateWhatsapp('p1', '')).alternativePhone, null);
  assert.deepEqual(userUpdates, [{ alternativePhone: null }]);
  for (const bad of ['abc', '12345', '+1234567890123456', '05 xx']) await assert.rejects(() => providerProfileService.updateWhatsapp('p1', bad), /INVALID_WHATSAPP/, bad);
  assert.equal(userUpdates.length, 1);
});

test('WhatsApp: the write contains ONLY alternativePhone (never the e-mail or the primary phone)', async (t) => {
  const { providerProfileService, userUpdates } = await loadWhatsapp(t);
  await providerProfileService.updateWhatsapp('p1', '+966501234567');
  assert.deepEqual(Object.keys(userUpdates[0]), ['alternativePhone']);
});

test('WhatsApp controller: 200 with the saved value, 400 INVALID_WHATSAPP with the Arabic message', async (t) => {
  let fail = false;
  t.mock.module('../services/provider-profile.service', { namedExports: {
    CONTACT_IMMUTABLE: 'CONTACT_IMMUTABLE', CONTACT_IMMUTABLE_MESSAGE: 'x',
    providerProfileService: { updateWhatsapp: async (_u: string, v: string) => { if (fail) throw new Error('INVALID_WHATSAPP'); return { alternativePhone: v || null }; } },
  } });
  const ctrl: any = await import(`../controllers/provider-profile.controller.ts?fixture=${Date.now()}-${Math.random()}`);
  const call = async (body: any) => { let status = 200; let json: any; const res: any = { status(c: number) { status = c; return res; }, json(b: any) { json = b; return res; } }; await ctrl.updateWhatsapp({ user: { id: 'p1' }, body } as any, res); return { status, json }; };
  const ok = await call({ alternativePhone: '+201025073026' });
  assert.deepEqual([ok.status, ok.json.data.alternativePhone, ok.json.message], [200, '+201025073026', 'تم حفظ رقم WhatsApp']);
  fail = true;
  const bad = await call({ alternativePhone: 'abc' });
  assert.deepEqual([bad.status, bad.json.code], [400, 'INVALID_WHATSAPP']);
  assert.match(bad.json.message, /WhatsApp/);
});
