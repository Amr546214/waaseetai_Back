/* eslint-disable */
// DEV ONLY. Creates (or resets) ONE ready-to-use CLIENT test account on the dev database: ACTIVE, e-mail verified, profile complete, KYC VERIFIED.
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
		accountType: 'CLIENT_INDIVIDUAL', status: 'ACTIVE', roles: ['CLIENT'], activeRole: 'CLIENT', isBanned: false,
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
	console.log(JSON.stringify({ ok: true, id: user.id, email: user.email, status: user.status, role: user.activeRole, reused: !!user && true }));
	await prisma.$disconnect();
})().catch((e) => { console.error('FAILED', e && e.message); process.exit(1); });
