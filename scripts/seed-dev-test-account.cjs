/* eslint-disable */
// DEV ONLY. Creates (or resets) ONE ready-to-use test account on the dev database holding ALL THREE roles (client + provider + marketer): ACTIVE, e-mail verified,
// every profile complete, KYC VERIFIED, the provider fully APPROVED (setup + test done, up to 3 approved specialties each with an approved sample) and the marketer
// onboarding complete (bio, avatar, one channel, payout, slug). It operates through the real role-state initializer; only the review outcomes are set directly.
// Run INSIDE the dev backend container (not shipped in the image): docker cp this file to /app/seed.cjs, then
//   SEED_EMAIL=... SEED_PASSWORD=... node /app/seed.cjs
// Refuses to run unless the database is the dev one AND SETUP_TEST_DEV_FALLBACK=true. Idempotent: running it again resets the password and the state of the same account.
// Login without an e-mail code also needs DEV_LOGIN_OTP_BYPASS_EMAILS=<this email> on the dev backend (utils/dev-login-otp-bypass).
const path = require('path');
const dist = (p) => require(path.join('/app/dist', p));

(async () => {
	const url = process.env.DATABASE_URL || '';
	if (!/wasit-pg-dev|waseetai_db_dev/.test(url) || process.env.SETUP_TEST_DEV_FALLBACK !== 'true') { console.error('REFUSED: not the dev environment'); process.exit(2); }
	const email = String(process.env.SEED_EMAIL || '').trim().toLowerCase();
	const password = String(process.env.SEED_PASSWORD || '');
	if (!email || password.length < 12) { console.error('SEED_EMAIL and a SEED_PASSWORD of at least 12 characters are required'); process.exit(2); }
	const bcrypt = require('/app/node_modules/bcrypt');
	const { prisma } = dist('config/db');
	const { initializeRoleState } = dist('services/account-management.service');
	const hash = await bcrypt.hash(password, 12);
	const base = {
		accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', roles: ['CLIENT', 'PROVIDER', 'AFFILIATE'], activeRole: 'CLIENT', isBanned: false,
		firstName: 'مختبر', lastName: 'التطوير', legalName: 'Dev Tester', username: 'dev.tester',
		phoneCountryCode: '+966', phoneNumber: '500009901', password: hash, agreedToTerms: true, authProvider: 'local',
		city: 'الرياض', region: 'الرياض', address: 'حساب اختبار على بيئة التطوير', profileCompletionPercent: 100,
	};
	const user = await prisma.$transaction(async (tx) => {
		const existing = await tx.user.findUnique({ where: { email } });
		const u = existing
			? await tx.user.update({ where: { id: existing.id }, data: { ...base, phoneNumber: existing.phoneNumber ?? base.phoneNumber } })
			: await tx.user.create({ data: { email, ...base } });
		await initializeRoleState(tx, u.id, 'CLIENT', u, { isProfileComplete: true });
		await tx.clientProfile.update({ where: { userId: u.id }, data: {
			kycStatus: 'VERIFIED', isProfileComplete: true, termsAgreed: true, privacyAgreed: true, accurateAgreed: true,
			country: 'السعودية', city: 'الرياض', completionPercentage: 100,
		} });
		return u;
	});
	// ---- provider: setup + test done, identity verified, approved specialties with an approved sample each ----
	const now = new Date();
	const specialties = await prisma.specialty.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 3, select: { id: true, nameAr: true } });
	await prisma.$transaction(async (tx) => {
		await initializeRoleState(tx, user.id, 'PROVIDER', user, {});
		const pp = await tx.providerProfile.update({ where: { userId: user.id }, data: {
			headline: 'مطوّر ومصمم حلول رقمية', bio: 'حساب اختبار على بيئة التطوير: مقدم خدمة معتمد لتجربة كل مسارات المنصة.', hourlyRate: 50, yearsOfExperience: 5,
			location: 'الرياض', city: 'الرياض', country: 'السعودية', languages: ['العربية', 'English'], mainSpecialty: specialties[0] ? specialties[0].nameAr : null,
			subSpecialties: [], kycStatus: 'VERIFIED', isVerified: true, isProfileSetupComplete: true, setupTestStatus: 'COMPLETED', setupTestScore: 90,
			termsAgreed: true, privacyAgreed: true, accurateAgreed: true, paymentType: 'paypal', paypalPayoutEmail: email, completionPercentage: 100, availabilityStatus: 'AVAILABLE',
		} });
		for (const sp of specialties) {
			let ps = await tx.providerSpecialty.findFirst({ where: { providerProfileId: pp.id, specialtyId: sp.id } });
			const data = { hasTakenAssessment: true, latestScore: 90, isPassed: true, passedAt: now, status: 'APPROVED', isActive: true, aiScore: 85, quizScore: 90, badgeGrantedAt: now, legalSignedAt: now, subSpecialties: [] };
			ps = ps ? await tx.providerSpecialty.update({ where: { id: ps.id }, data }) : await tx.providerSpecialty.create({ data: { providerProfileId: pp.id, specialtyId: sp.id, ...data } });
			const title = 'نموذج أعمال اختباري - ' + sp.nameAr;
			const has = await tx.accreditationSample.findFirst({ where: { providerSpecialtyId: ps.id, title } });
			if (!has) {
				const sample = await tx.accreditationSample.create({ data: {
					providerProfileId: pp.id, providerSpecialtyId: ps.id, title, description: 'نموذج أعمال تجريبي على بيئة التطوير لحساب الاختبار؛ ليس عملًا حقيقيًا.',
					technologiesUsed: ['Angular', 'Node.js'], attachments: [], status: 'AI_VERIFIED', aiScore: 85, aiQualityRating: 'Good', aiAuditedAt: now, decidedAt: now,
					aiFeedbackAr: 'بيانات اختبار على بيئة التطوير: لم يُجرَ تقييم فعلي.',
				} });
				await tx.accreditationSampleEvent.create({ data: { sampleId: sample.id, kind: 'APPROVED', revision: 1, actorId: null } });
			}
		}
	});
	// ---- marketer: bio, avatar, one channel, payout, slug; identity verified ----
	await prisma.$transaction(async (tx) => {
		await initializeRoleState(tx, user.id, 'AFFILIATE', user, {});
		const ap = await tx.affiliateProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
		await tx.affiliateProfile.update({ where: { userId: user.id }, data: {
			bio: 'حساب اختبار على بيئة التطوير: وسيط تسويقي لتجربة الإحالات والعمولات والسحب.', avatarUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
			identityVerified: true, payoutMethod: 'PAYPAL', paypalPayoutEmail: email, completionPercentage: 100, notifyOnNewReferral: true,
		} });
		const hasChannel = await tx.affiliateChannelHandle.findFirst({ where: { affiliateProfileId: ap.id } });
		if (!hasChannel) await tx.affiliateChannelHandle.create({ data: { affiliateProfileId: ap.id, platform: 'LINKEDIN', handle: '@dev.tester', url: 'https://www.linkedin.com/in/dev-tester' } });
	});
	await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' } });
	const roles = await prisma.user.findUnique({ where: { id: user.id }, select: { roles: true, activeRole: true } });
	const sp = await prisma.providerSpecialty.count({ where: { providerProfile: { userId: user.id }, status: 'APPROVED', isActive: true } });
	console.log(JSON.stringify({ ok: true, id: user.id, email: user.email, status: user.status, role: user.activeRole, approvedSpecialties: sp, roles: roles.roles }));
	await prisma.$disconnect();
})().catch((e) => { console.error('FAILED', e && e.message); process.exit(1); });
