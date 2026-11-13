import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLegalName, cleanLegalName, legalNameKey, sameLegalName } from './legal-name';

test('a normal Arabic and Latin legal name is accepted and tidied', () => {
	assert.deepEqual(checkLegalName('  عمرو   محمود '), { ok: true, value: 'عمرو محمود' });
	assert.deepEqual(checkLegalName('Amr Mahmoud-Ali'), { ok: true, value: 'Amr Mahmoud-Ali' });
	assert.deepEqual(checkLegalName('محمد​ أحمد'), { ok: true, value: 'محمد أحمد' });
});
test('required, one-word, digits, symbols, markup and too-long names are refused with a code', () => {
	assert.equal((checkLegalName('') as any).code, 'LEGAL_NAME_REQUIRED');
	assert.equal((checkLegalName('<b></b>') as any).code, 'LEGAL_NAME_REQUIRED');
	assert.equal((checkLegalName('عمرو') as any).code, 'LEGAL_NAME_NEEDS_TWO_PARTS');
	assert.equal((checkLegalName('عمرو 2') as any).code, 'LEGAL_NAME_INVALID_CHARS');
	assert.equal((checkLegalName('عمرو ٢٣') as any).code, 'LEGAL_NAME_INVALID_CHARS');
	assert.equal((checkLegalName('Amr @ Mahmoud') as any).code, 'LEGAL_NAME_INVALID_CHARS');
	assert.equal((checkLegalName('ا ب') as any).code, 'LEGAL_NAME_TOO_SHORT');
	assert.equal((checkLegalName('أ'.repeat(70) + ' ' + 'ب'.repeat(70)) as any).code, 'LEGAL_NAME_TOO_LONG');
});
test('conservative equality: diacritics, kashida, spaces and Latin case only; different letters never merge', () => {
	assert.equal(sameLegalName('عَمْرو  محمود', 'عمرو محمود'), true);
	assert.equal(sameLegalName('عمـــرو محمود', 'عمرو محمود'), true);
	assert.equal(sameLegalName('AMR mahmoud', 'amr Mahmoud'), true);
	assert.equal(sameLegalName('أحمد علي', 'احمد علي'), false);
	assert.equal(sameLegalName('فاطمة علي', 'فاطمه علي'), false);
	assert.equal(sameLegalName('عمرو محمود', 'عمرو محمد'), false);
	assert.equal(sameLegalName('', ''), false);
	assert.equal(legalNameKey(cleanLegalName('x')), 'x');
});
