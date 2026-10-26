import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * The SAR currency from the START of the real flows, on an isolated PostgreSQL, nothing built by hand but the users and the wallet: the Super Admin selects SAR through the settings API (the readiness gate
 * must allow it), then a NEW request, offer, selection, signature, escrow, delivery, approval and settlement are all created through the application's own services. The currency is the platform's at the moment
 * each ROOT record is created and every record derived from it inherits it; changing the setting again moves nothing that exists. SAR has no payment gateway (none is enabled anywhere), so the SAR wallet
 * is funded directly in wallet_balances - the only line of the setup that is not a service call.
 */
const PG_URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!PG_URL && PG_URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(PG_URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };
process.env.JWT_SECRET ??= 'test-secret'; process.env.OPENAI_API_KEY ??= 'x'; process.env.OTP_SECRET ??= 'otp-secret-for-tests';
process.env.CLOUDINARY_CLOUD_NAME ??= 'testcloud'; process.env.CLOUDINARY_API_KEY ??= '123456789012345'; process.env.CLOUDINARY_API_SECRET ??= 'fake-secret-for-signing-only';
const id = () => randomUUID();
let lastOtp = ''; const sent: Array<{ to: string; subject: string; html: string }> = [];
mock.module('../utils/mail.transporter', { namedExports: {
	mailTransporter: { sendMail: async (m: any) => { sent.push({ to: m.to, subject: m.subject, html: String(m.html) }); return { accepted: [m.to], rejected: [], messageId: 'x' }; } },
	getOtpEmailTemplate: (code: string) => { lastOtp = code; return `otp:${code}`; }, getDepositConfirmationTemplate: (n: string, a: number, c: string) => `deposit:${n}:${a}:${c}`, getProviderContractSignatureTemplate: (n: string, cl: string, a: number, c: string) => `sign:${n}:${a}:${c}`,
	getPasswordResetEmailTemplate: () => '',
} });

async function world() {
	const { prisma } = await import('../config/db'); const tag = id().slice(0, 8);
	const mk = (n: string, accountType: string, role: string, extra: any = {}) => prisma.user.create({ data: { id: id(), accountType: accountType as any, firstName: n, lastName: tag, email: `${n}-${tag}@pg.test`, roles: [role] as any, activeRole: role as any, ...extra } });
	const client = await mk('client', 'CLIENT_INDIVIDUAL', 'CLIENT'), provider = await mk('prov', 'PROVIDER_INDIVIDUAL', 'PROVIDER'), admin = await mk('admin', 'SUPER_ADMIN', 'SUPER_ADMIN', { status: 'ACTIVE' });
	const cat = await prisma.category.create({ data: { id: id(), slug: `c-${tag}`, nameAr: 'تصنيف' } });
	const spec = await prisma.specialty.create({ data: { id: id(), slug: `s-${tag}`, categoryId: cat.id, nameAr: 'تخصص' } });
	await prisma.clientProfile.create({ data: { id: id(), userId: client.id } as any });
	const pp = await prisma.providerProfile.create({ data: { id: id(), userId: provider.id, kycStatus: 'VERIFIED' } });
	const ps = await prisma.providerSpecialty.create({ data: { id: id(), providerProfileId: pp.id, specialtyId: spec.id, subSpecialties: [], status: 'APPROVED', isPassed: true, isActive: true } as any });
	const sample = await prisma.accreditationSample.create({ data: { id: id(), providerProfileId: pp.id, providerSpecialtyId: ps.id, title: 'نموذج', description: 'وصف', technologiesUsed: [], attachments: [], status: 'AI_VERIFIED' } as any });
	return { prisma, tag, client, provider, admin, spec, ps, sample };
}
const setBase = async (w: Awaited<ReturnType<typeof world>>, cur: 'USD' | 'SAR') => {
	const { systemSettingsService } = await import('./system-settings.service'); const cur0 = await w.prisma.platformSetting.findUnique({ where: { key: 'baseCurrency' } });
	return systemSettingsService.update({ userId: w.admin.id, isSuperAdmin: true, staffId: null, staffStatus: null, roleId: null, roleName: null, permissions: new Set<string>() } as any, { changes: { baseCurrency: cur }, expected: { baseCurrency: (cur0 as any)?.version ?? 0 } });
};
const MILESTONES = [{ stepOrder: 1, title: 'مرحلة أولى', description: 'وصف كافٍ لهذه المرحلة', days: 5, percentage: 40, amount: 400 }, { stepOrder: 2, title: 'مرحلة ثانية', description: 'وصف كافٍ لهذه المرحلة', days: 5, percentage: 60, amount: 600 }];

test('pg SAR natural flow: request -> offer -> selection -> contract -> signature+funding -> provider signs the shown terms -> deliveries -> approvals -> settlement, all in SAR, USD untouched, and a later change of the setting moves nothing', opts, async () => {
	const w = await world(); const { prisma } = w;
	const { clientRequestsService } = await import('./client-requests.service'); const { proposalService } = await import('./proposal.service');
	const { projectProgressService } = await import('./project-progress.service'); const { signContract } = await import('../controllers/provider.controller');
	await prisma.user.update({ where: { id: w.client.id }, data: { walletBalance: 777 } }); // a USD balance that must never be touched
	await prisma.walletBalance.create({ data: { userId: w.client.id, currency: 'SAR', balance: 1500 } });

	// 1. the Super Admin selects SAR through the settings API: the readiness gate allows it (nothing in the ledger is unverified, nothing is open), and no gateway is enabled by it
	await setBase(w, 'SAR');
	const { platformCurrency } = await import('./platform-currency'); const { gatewayAccepts } = await import('../config/payment-gateways');
	// the DB is shared with earlier tests of the run: measure this flow as a difference against what was already released
	const { adminFinanceService: adminFinance0 } = await import('./admin-finance.service'); const ov0: any = await adminFinance0.overview(1);
	const sar0 = ov0.totals.releasedGross as number; const usd0 = (ov0.byCurrency?.USD?.releasedGross ?? 0) as number;
	assert.equal(await platformCurrency(), 'SAR'); assert.equal(gatewayAccepts('arb', 'SAR'), false); assert.equal(gatewayAccepts('paypal', 'SAR'), false);

	// 2. a NEW request: SAR (the platform currency at creation), and its mirrored project
	const req: any = await clientRequestsService.createRequest(w.client.id, { title: 'طلب بالريال', description: 'وصف تفصيلي كافٍ للطلب لاختبار العملة', specialtyId: w.spec.id, budgetType: 'FIXED', minBudget: 800, maxBudget: 1200, expectedDurationDays: 10 } as any);
	assert.equal((await prisma.clientRequest.findUniqueOrThrow({ where: { id: req.id } })).currency, 'SAR'); assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: req.id } })).currency, 'SAR');

	// 3. the provider's offer: inherits the request's currency (offer, legacy mirror, milestones)
	const offer: any = await proposalService.createProposal(req.id, w.provider.id, { title: 'عرض بالريال', message: 'وصف تفصيلي لعرضي يوضح خبرتي ومنهجيتي في العمل على هذا المشروع بشكل كامل.', advantages: [], outputs: '', portfolioIds: [], totalPrice: 1000, deliveryDays: 10, milestones: MILESTONES, agreedToTerms: true, agreedToEscrow: true } as any);
	assert.equal((await prisma.projectProposal.findFirstOrThrow({ where: { projectId: req.id, providerId: w.provider.id } })).currency, 'SAR');
	assert.equal((await prisma.proposalMilestone.findMany({ where: { proposal: { projectId: req.id } } })).every((m: any) => m.currency === 'SAR'), true);
	assert.equal((await prisma.proposal.findFirstOrThrow({ where: { clientRequestId: req.id, providerId: w.provider.id } })).currency, 'SAR');

	// 4. the client selects the offer: the contract is SAR; changing the setting back to USD right now must not move it
	await clientRequestsService.selectOffer(w.client.id, req.id, offer.id);
	const contract0 = await prisma.contract.findUniqueOrThrow({ where: { projectId: req.id } }); assert.equal(contract0.currency, 'SAR'); assert.equal(contract0.price, 1000);

	// 5. a USD-only wallet cannot fund a SAR contract (402 naming SAR, nothing created), the SAR wallet can
	await prisma.walletBalance.update({ where: { userId_currency: { userId: w.client.id, currency: 'SAR' } }, data: { balance: 10 } });
	await clientRequestsService.signContract(w.client.id, req.id, offer.id); const poor = lastOtp;
	const refused: any = await clientRequestsService.depositEscrow(w.client.id, req.id, offer.id, poor, 'wallet').catch((e: any) => e);
	assert.equal(refused.statusCode, 402); assert.equal(refused.errors?.[0]?.currency, 'SAR'); assert.equal(await prisma.escrow.count({ where: { projectId: req.id } }), 0);
	await prisma.walletBalance.update({ where: { userId_currency: { userId: w.client.id, currency: 'SAR' } }, data: { balance: 1500 } });
	await clientRequestsService.signContract(w.client.id, req.id, offer.id);
	await clientRequestsService.depositEscrow(w.client.id, req.id, offer.id, lastOtp, 'wallet');
	const escrow = await prisma.escrow.findUniqueOrThrow({ where: { projectId: req.id } });
	assert.equal(escrow.currency, 'SAR'); assert.equal(escrow.amount, 1000); assert.equal(escrow.status, 'HELD');
	assert.equal(Number((await prisma.walletBalance.findUniqueOrThrow({ where: { userId_currency: { userId: w.client.id, currency: 'SAR' } } })).balance), 500); assert.equal(Number((await prisma.user.findUniqueOrThrow({ where: { id: w.client.id } })).walletBalance), 777);
	assert.ok((await prisma.walletTransaction.findMany({ where: { userId: w.client.id, type: 'ESCROW_LOCK' } })).every((t: any) => t.currency === 'SAR'));
	assert.ok(sent.some(m => /deposit:.*:1000:SAR/.test(m.html)) && sent.some(m => /sign:.*:1000:SAR/.test(m.html)), 'the confirmation mails carry SAR');

	// 6. the provider is SHOWN the final terms (SAR, commission, net) and signs exactly those
	const view = ((await proposalService.getProviderOffers(w.provider.id, {})) as any).data.find((o: any) => o.contract)?.contract;
	assert.equal(view.currency, 'SAR'); assert.ok(view.providerTerms && view.providerTerms.net < 1000 && view.termsDigest, JSON.stringify(view));
	const sign = async (agreedTerms: any) => { let status = 200; let body: any; await signContract({ user: { id: w.provider.id }, params: { id: offer.id }, body: { agreedTerms } } as any, { status(s: number) { status = s; return this; }, json(b: any) { body = b; return this; } } as any, (e: any) => { status = e?.statusCode ?? 500; body = e; }); return { status, body }; };
	assert.equal((await sign({ accepted: true })).status, 400);
	assert.equal((await sign({ accepted: true, termsDigest: 'f'.repeat(64) })).status, 409);
	assert.equal((await sign({ accepted: true, termsDigest: view.termsDigest })).status, 200);
	assert.equal((await prisma.contract.findUniqueOrThrow({ where: { projectId: req.id } })).status, 'ACTIVE');

	// 7. stages exist in SAR; deliver and approve both: the escrow is released in SAR with the frozen commission
	await projectProgressService.getProjectProgress(w.client.id, req.id);
	const stages = await prisma.projectStage.findMany({ where: { contractId: contract0.id }, orderBy: { stepOrder: 'asc' } });
	assert.equal(stages.length, 2); assert.ok(stages.every((s: any) => s.currency === 'SAR'));
	for (const st of stages) { await projectProgressService.submitDelivery(w.provider.id, req.id, st.id, 'ملاحظة تسليم كافية للمرحلة', ['https://example.com/delivery']); await projectProgressService.reviewDelivery(w.client.id, req.id, st.id, 'approve'); }
	const done = await prisma.escrow.findUniqueOrThrow({ where: { projectId: req.id } });
	assert.equal(done.currency, 'SAR'); assert.equal(done.status, 'RELEASED'); assert.equal(done.releasedAmount, 1000); assert.ok(done.platformCommissionAmount > 0 && Math.abs(done.platformCommissionAmount + done.providerNetReleasedAmount - 1000) < 0.011);

	// 8. headline figures follow the platform currency (SAR); USD, if any, would be listed apart. The provider's SAR earnings are NOT withdrawable (payouts are USD only)
	const { providerFinanceService } = await import('./provider-finance.service'); const wallet = await providerFinanceService.getWallet(w.provider.id);
	assert.equal(wallet.summary.currency, 'SAR'); assert.equal(wallet.summary.availableBalance, done.providerNetReleasedAmount); assert.equal(wallet.summary.withdrawableBalance, 0); assert.equal(wallet.summary.byCurrency?.SAR?.payoutSupported, false);
	const { adminFinanceService } = await import('./admin-finance.service'); const ov: any = await adminFinanceService.overview(1);
	assert.equal(ov.currency, 'SAR'); assert.equal(Math.round((ov.totals.releasedGross - sar0) * 100) / 100, 1000); assert.equal(Math.round((ov.byCurrency.SAR.releasedGross - sar0) * 100) / 100, 1000);
	const { clientFinanceService } = await import('./client-finance.service'); const cw: any = await clientFinanceService.getWallet(w.client.id);
	assert.equal(cw.summary.currency, 'SAR'); assert.equal(cw.summary.availableBalance, 500); assert.equal(cw.summary.balances.USD, 777);

	// 9. the setting goes back to USD: nothing that exists changes currency; the headline is USD again and SAR is listed apart
	await setBase(w, 'USD');
	assert.equal((await prisma.contract.findUniqueOrThrow({ where: { projectId: req.id } })).currency, 'SAR'); assert.equal((await prisma.escrow.findUniqueOrThrow({ where: { projectId: req.id } })).currency, 'SAR');
	const ov2: any = await adminFinanceService.overview(1); assert.equal(ov2.currency, 'USD'); assert.equal(ov2.totals.releasedGross, usd0); assert.equal(Math.round((ov2.byCurrency.SAR.releasedGross - sar0) * 100) / 100, 1000); assert.equal(ov2.mixedCurrencies, Object.values(ov2.byCurrency.USD ?? {}).some(v => v !== 0)); // mixed exactly when USD figures also exist (earlier tests of a shared run may have left some)
});

test('pg SAR natural flow: a SERVICE created while SAR is the platform currency is SAR, and its order, contract, escrow and stages follow it through checkout', opts, async () => {
	const w = await world(); const { prisma } = w; await setBase(w, 'SAR');
	const { MarketplaceService } = await import('./marketplace-service.service'); const marketplaceService = new MarketplaceService(); const { cartCheckoutService } = await import('./cart-checkout.service');
	await prisma.walletBalance.create({ data: { userId: w.client.id, currency: 'SAR', balance: 300 } });
	const created: any = await marketplaceService.createService(w.provider.id, { title: 'خدمة بالريال', description: 'وصف الخدمة بالتفصيل الكافي', specialtyId: w.spec.id, accreditationSampleId: w.sample.id, stages: [{ title: 'مرحلة', percentage: 100, deliveryDays: 7, computedAmount: 200 }], gallery: [] });
	const service = await prisma.serviceCatalog.findFirstOrThrow({ where: { providerId: w.provider.id } }); assert.equal(service.currency, 'SAR');
	await prisma.serviceCatalog.update({ where: { id: service.id }, data: { status: 'PUBLISHED' } });
	const order: any = await cartCheckoutService.createOrder(w.client.id, { items: [{ modelId: service.id }] }); assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).currency, 'SAR');
	await prisma.otpVerification.create({ data: { userId: w.client.id, code: '123456', type: 'EMAIL', expiresAt: new Date(Date.now() + 120_000), context: { purpose: 'checkout_payment', orderId: order.id, paymentReference: `PAY-${id().slice(0, 8)}`, paymentMethod: 'wallet' } } });
	await cartCheckoutService.confirmPayment(w.client.id, order.id, '123456');
	const project = await prisma.project.findFirstOrThrow({ where: { clientId: w.client.id }, include: { contract: { include: { stages: true } }, escrow: true } });
	assert.deepEqual([project.currency, project.contract.currency, project.escrow.currency, ...project.contract.stages.map((s: any) => s.currency)], ['SAR', 'SAR', 'SAR', 'SAR']);
	assert.equal(Number((await prisma.walletBalance.findUniqueOrThrow({ where: { userId_currency: { userId: w.client.id, currency: 'SAR' } } })).balance), 100);
	void created;
});
