import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Registration stores the phone as (country code, LOCAL number) and refuses a number that is not a mobile number of the chosen country.
const created: any[] = [];
let loaded: Promise<any> | undefined;
function load() {
	loaded ??= (async () => {
		mock.module('../repositories/auth.repository', { namedExports: { authRepository: { findByEmailOrPhone: async () => null, createUserWithProfile: async (d: any) => { created.push(d); return { id: 'new-user', email: d.email }; }, createOtp: async () => ({}) } } });
		mock.module('../config/db', { namedExports: { prisma: { affiliateProfile: { findFirst: async () => null }, referral: { create: async () => ({}) } } } });
		mock.module('../config/logger', { namedExports: { logger: { info() {}, warn() {}, error() {}, debug() {} } } });
		mock.module('./notification.service', { namedExports: { notificationService: { sendEmailOtp: async () => {} } } });
		return (await import('./auth.service')).authService;
	})();
	return loaded;
}
const BASE: any = { accountType: 'CLIENT_INDIVIDUAL', firstName: 'Test', lastName: 'User', email: 'new@example.com', password: 'Password1', agreedToTerms: true };
async function register(phoneCountryCode: string, phoneNumber: string) {
	created.length = 0;
	return (await load()).registerUser({ ...BASE, phoneCountryCode, phoneNumber });
}

test('Egypt: +20 with the local number is stored as the code and the local digits', async () => {
	await register('+20', '1025073026');
	assert.deepEqual([created[0].phoneCountryCode, created[0].phoneNumber], ['+20', '1025073026']);
});

test('Saudi: a leading zero is dropped, the code stays +966', async () => {
	await register('+966', '0501234567');
	assert.deepEqual([created[0].phoneCountryCode, created[0].phoneNumber], ['+966', '501234567']);
});

test('a full number pasted into the number field is split: 201025073026 -> +20 and 1025073026', async () => {
	await register('+20', '201025073026');
	assert.deepEqual([created[0].phoneCountryCode, created[0].phoneNumber], ['+20', '1025073026']);
});

test('an Egyptian number with +966 (and a Saudi number with +20) is refused and nothing is created', async () => {
	await assert.rejects(() => register('+966', '1025073026'), (e: any) => e.statusCode === 400 && /رمز الدولة/.test(e.message));
	assert.equal(created.length, 0);
	await assert.rejects(() => register('+20', '501234567'), (e: any) => e.statusCode === 400);
	assert.equal(created.length, 0);
});
