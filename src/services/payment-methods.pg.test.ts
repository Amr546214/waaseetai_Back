import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const url = process.env.QA_ISOLATED_PG_URL;
const opts = { skip: !(url && url === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(url)) };
const iban = () => {
  const account = '80000000000000000001'; let r = 0;
  for (const c of account + '281000') r = (r * 10 + +c) % 97;
  return `SA${String(98 - r).padStart(2, '0')}${account}`;
};

test('PG: real migration, encrypted storage, role/owner isolation, OAuth one-use, canonical destination and provider OTP/freeze', opts, async t => {
  Object.assign(process.env, { PAYMENT_METHODS_ENV: 'sandbox', PAYMENT_METHODS_ENCRYPTION_KEY: '4'.repeat(64), PAYPAL_CONNECT_MODE: 'sandbox', PAYPAL_CONNECT_CLIENT_ID: 'synthetic-id', PAYPAL_CONNECT_CLIENT_SECRET: 'synthetic-secret', PAYPAL_CONNECT_RETURN_URL: 'https://dev.waseetai.com/payment-methods/paypal-return' });
  const { prisma } = await import('../config/db');
  const { PaymentMethodsService } = await import('./payment-methods.service');
  const { notificationService } = await import('./notification.service');
  const { providerNotifications } = await import('./provider-notifications.service');
  const { marketerNotifications } = await import('./marketer-notifications.service');
  const { paypalEmailChangeService } = await import('./paypal-email-change.service');
  t.mock.method(notificationService, 'sendPaypalEmailChangeOtpEmail', async () => undefined);
  t.mock.method(providerNotifications, 'paypalEmailChanged', async () => undefined);
  const marketerNotice = t.mock.method(marketerNotifications, 'paypalEmailChanged', async () => undefined);
  const uid = randomUUID(), otherId = randomUUID();
  for (const id of [uid, otherId]) await prisma.user.create({ data: { id, accountType: 'PROVIDER_INDIVIDUAL', activeRole: 'PROVIDER', roles: ['CLIENT', 'PROVIDER', 'AFFILIATE'], status: 'ACTIVE', email: `${id}@payment.test`, firstName: 'Synthetic', lastName: 'Owner' } });
  t.after(async () => { await prisma.user.deleteMany({ where: { id: { in: [uid, otherId] } } }); });
  for (const id of [uid, otherId]) {
    await prisma.providerProfile.create({ data: { userId: id, paypalPayoutEmail: 'old-provider@payment.test' } });
    await prisma.clientProfile.create({ data: { userId: id, paypalPayoutEmail: 'old-client@payment.test' } });
    await prisma.affiliateProfile.create({ data: { userId: id, paypalPayoutEmail: 'old-affiliate@payment.test' } });
  }
  let externalCalls = 0, emailVerified: boolean | null = true;
  const network: typeof fetch = async (input, init) => {
    externalCalls++;
    const href = String(input);
    assert.ok(href.startsWith('https://api-m.sandbox.paypal.com/'));
    if (href.endsWith('/token')) { assert.equal(init?.method, 'POST'); assert.match(String(init?.body), /grant_type=authorization_code/); return new Response(JSON.stringify({ access_token: 'synthetic-access-token' })); }
    return new Response(JSON.stringify({ sub: 'synthetic-subject', user_id: 'synthetic-user-id', email: 'linked@payment.test', ...(emailVerified === null ? {} : { email_verified: emailVerified }), verified_account: false }));
  };
  const service = new PaymentMethodsService(prisma, network);
  const a = { userId: uid, role: 'PROVIDER' as const, sessionId: randomUUID() };
  const client = { ...a, role: 'CLIENT' as const }, affiliate = { ...a, role: 'AFFILIATE' as const };
  const b = { ...a, userId: otherId };

  await t.test('bank records never imply verification or change canonical payout fields; duplicate saves update one row', async () => {
    const bank = { accountHolder: 'Synthetic Bank Owner', iban: iban(), label: 'حسابي' };
    let listed = await service.bank(a, bank); const id = listed.methods[0]!.id;
    assert.equal(listed.methods[0]!.status, 'UNVERIFIED'); assert.equal(listed.methods[0]!.isDefault, false);
    const row = await prisma.paymentMethod.findUniqueOrThrow({ where: { id } });
    assert.ok(!row.encryptedDetails.includes(bank.iban)); assert.ok(!row.encryptedDetails.includes(bank.accountHolder));
    assert.ok(!JSON.stringify(listed).includes(bank.accountHolder)); assert.ok(!JSON.stringify(listed).includes(bank.iban));
    assert.equal((await service.detail(a, id)).iban, bank.iban);
    await assert.rejects(service.detail(b, id), (e: any) => e.statusCode === 404);
    await assert.rejects(service.detail(client, id), (e: any) => e.statusCode === 404);
    listed = await service.bank(a, { ...bank, label: 'محدّث' }); assert.equal(listed.methods.length, 1);
    await assert.rejects(service.makeDefault(a, id), (e: any) => e.statusCode === 409);
    await assert.rejects(prisma.paymentMethod.update({ where: { id }, data: { isDefault: true } }));
    assert.equal((await prisma.providerProfile.findUniqueOrThrow({ where: { userId: uid } })).paypalPayoutEmail, 'old-provider@payment.test');
  });
  const stateOf = (r: { url: string }) => new URL(r.url).searchParams.get('state')!;
  await t.test('challenge requires matching owner, role, session, current attempt and time, and is consumed once across concurrent calls', async () => {
    const first = stateOf(await service.start(a)), second = stateOf(await service.start(a));
    await assert.rejects(service.complete(a, 'code', first));
    for (const wrong of [b, client, { ...a, sessionId: randomUUID() }]) await assert.rejects(service.complete(wrong, 'code', second));
    assert.equal(externalCalls, 0);
    const result = await Promise.allSettled([service.complete(a, 'code', second), service.complete(a, 'code', second)]);
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1); assert.equal(externalCalls, 2);
    let listed = await service.list(a); const paypal = listed.methods.find(m => m.kind === 'PAYPAL')!;
    assert.equal(paypal.status, 'NEEDS_ACTIVATION'); assert.equal(paypal.accountVerified, false);
    assert.equal((await service.list(client)).methods.length, 0);
    const expired = stateOf(await service.start(a));
    await prisma.paymentMethodAuthorization.updateMany({ where: { userId: uid }, data: { expiresAt: new Date(0) } });
    await assert.rejects(service.complete(a, 'code', expired)); assert.equal(externalCalls, 2);
  });
  await t.test('provider payout activation preserves real OTP and 24-hour freeze; separate role destinations stay intact', async () => {
    const method = (await service.list(a)).methods.find(m => m.kind === 'PAYPAL')!;
    const activation = await service.activate(a, method.id); assert.equal(activation.otpRequired, true);
    assert.equal((await prisma.providerProfile.findUniqueOrThrow({ where: { userId: uid } })).paypalPayoutEmail, 'old-provider@payment.test');
    const otp = await prisma.otpVerification.findFirstOrThrow({ where: { userId: uid, type: 'EMAIL' }, orderBy: { createdAt: 'desc' } });
    await service.confirm(a, method.id, otp.code);
    assert.equal((await service.list(a)).methods.find(m => m.kind === 'PAYPAL')!.status, 'CONNECTED');
    assert.ok(await paypalEmailChangeService.frozenUntil(uid));
    await service.makeDefault(a, method.id);
    assert.equal((await service.list(a)).methods.find(m => m.id === method.id)!.isDefault, true);
    assert.equal((await prisma.clientProfile.findUniqueOrThrow({ where: { userId: uid } })).paypalPayoutEmail, 'old-client@payment.test');
    assert.equal((await prisma.affiliateProfile.findUniqueOrThrow({ where: { userId: uid } })).paypalPayoutEmail, 'old-affiliate@payment.test');
    // Legacy profile edits immediately invalidate display/eligibility of the previous proof/default.
    await prisma.providerProfile.update({ where: { userId: uid }, data: { paypalPayoutEmail: 'changed@payment.test' } });
    assert.equal((await service.list(a)).methods.find(m => m.id === method.id)!.isDefault, false);
    await assert.rejects(service.makeDefault(a, method.id));
  });
  await t.test('client and affiliate activate only their own canonical profile; missing email confirmation never becomes success', async () => {
    for (const actor of [client, affiliate]) {
      await service.complete(actor, 'code', stateOf(await service.start(actor)));
      const method = (await service.list(actor)).methods[0]!;
      await service.activate(actor, method.id);
      assert.equal((await service.list(actor)).methods[0]!.status, 'CONNECTED');
    }
    assert.equal((await prisma.clientProfile.findUniqueOrThrow({ where: { userId: uid } })).paymentType, 'paypal');
    assert.ok((await prisma.clientProfile.findUniqueOrThrow({ where: { userId: uid } })).completionPercentage > 0);
    assert.ok((await prisma.affiliateProfile.findUniqueOrThrow({ where: { userId: uid } })).completionPercentage > 0);
    assert.equal(marketerNotice.mock.callCount(), 1);
    emailVerified = null;
    await service.complete(client, 'code', stateOf(await service.start(client)));
    const method = (await service.list(client)).methods[0]!;
    assert.equal(method.status, 'EMAIL_UNCONFIRMED');
    await assert.rejects(service.activate(client, method.id));
    await assert.rejects(service.makeDefault(client, method.id));
  });
  await t.test('disconnect removes proof only, keeps canonical destination and previous withdrawal snapshots', async () => {
    const withdrawal = await prisma.withdrawal.create({ data: { userId: uid, amount: 20, currency: 'USD', method: 'paypal', paypalEmail: 'historical@payment.test', referenceId: `W-${randomUUID()}` } });
    const method = (await service.list(client)).methods[0]!;
    await assert.rejects(service.remove(b, method.id));
    await service.remove(client, method.id);
    assert.ok((await service.list(client)).legacyPaypal);
    assert.equal((await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })).paypalEmail, 'historical@payment.test');
    await prisma.withdrawal.delete({ where: { id: withdrawal.id } });
  });
  await t.test('HTTP router requires a real active session and expected role; refuses forged ownership and foreign method ids', async () => {
    const { default: express } = await import('express');
    const { default: jwt } = await import('jsonwebtoken');
    const { default: router } = await import('../routes/payment-methods.routes');
    const app = express(); app.use(express.json()); app.use('/api/payment-methods', router);
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/api/payment-methods`;
    const token = jwt.sign({ userId: uid, accountType: 'PROVIDER_INDIVIDUAL' }, process.env.JWT_SECRET!, { expiresIn: '10m' });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    try {
      assert.equal((await fetch(`${base}?role=PROVIDER`)).status, 401);
      assert.equal((await fetch(`${base}?role=CLIENT`, { headers })).status, 403);
      assert.equal((await fetch(`${base}?role=PROVIDER`, { headers })).status, 200);
      const foreign = (await service.bank(b, { accountHolder: 'Other Owner', iban: iban() })).methods[0]!;
      assert.equal((await fetch(`${base}/${foreign.id}?role=PROVIDER`, { headers })).status, 404);
      assert.equal((await fetch(`${base}/alrajhi?role=PROVIDER`, { method: 'POST', headers, body: JSON.stringify({ accountHolder: 'My Owner', iban: iban(), userId: otherId, verified: true }) })).status, 400);
      assert.equal((await fetch(`${base}/paypal/complete?role=PROVIDER`, { method: 'POST', headers, body: JSON.stringify({ code: 'code', state: 'not-valid' }) })).status, 400);
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });
});
