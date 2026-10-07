import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockCompanySetup, COMPANY_ACCOUNTS_UNAVAILABLE_MESSAGE } from './company-unavailable.middleware';

const run = (accountType: string | undefined) => {
	let err: any = 'not-called';
	blockCompanySetup({ user: accountType ? { accountType } : undefined } as any, {} as any, (e?: any) => { err = e; });
	return err;
};

test('company setup save is refused with 403 and the Arabic message (both company types)', () => {
	for (const t of ['CLIENT_COMPANY', 'PROVIDER_COMPANY']) {
		const e = run(t);
		assert.equal(e.statusCode ?? e.status, 403);
		assert.equal(e.message, COMPANY_ACCOUNTS_UNAVAILABLE_MESSAGE);
	}
	assert.equal(COMPANY_ACCOUNTS_UNAVAILABLE_MESSAGE, 'حسابات الشركات غير متاحة حاليًا');
});

test('individual, provider and marketer setup is not affected', () => {
	for (const t of ['CLIENT_INDIVIDUAL', 'PROVIDER_INDIVIDUAL', 'MARKETING_BROKER']) assert.equal(run(t), undefined);
});
