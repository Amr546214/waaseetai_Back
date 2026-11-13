import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUsername, displayNameOf } from './username';

test('a single word is a valid username; Arabic, Latin, digits and a few separators are accepted and tidied', () => {
	assert.deepEqual(checkUsername('عمرو'), { ok: true, value: 'عمرو' });
	assert.deepEqual(checkUsername('  عمرو   م  '), { ok: true, value: 'عمرو م' });
	assert.deepEqual(checkUsername('amr_99'), { ok: true, value: 'amr_99' });
	assert.deepEqual(checkUsername('Dev.Amr-1'), { ok: true, value: 'Dev.Amr-1' });
});
test('required, too short, too long, links / addresses / markup / symbols are refused with a code', () => {
	assert.equal((checkUsername('') as any).code, 'USERNAME_REQUIRED');
	assert.equal((checkUsername('<b></b>') as any).code, 'USERNAME_REQUIRED');
	assert.equal((checkUsername('ع') as any).code, 'USERNAME_TOO_SHORT');
	assert.equal((checkUsername('1') as any).code, 'USERNAME_TOO_SHORT');
	assert.equal((checkUsername('ع'.repeat(61)) as any).code, 'USERNAME_TOO_LONG');
	for (const bad of ['a@b.com', 'https://x.test', 'www.x.test', 'عمرو/م', '@amr', '__x', '😀 amr']) assert.equal((checkUsername(bad) as any).code, 'USERNAME_INVALID_CHARS', bad);
});
test('the platform shows the username when chosen, else the older first/last name; the legal name is never part of it', () => {
	assert.equal(displayNameOf({ username: 'عمرو', firstName: 'Amr', lastName: 'Mahmoud' }), 'عمرو');
	assert.equal(displayNameOf({ username: null, firstName: 'Amr', lastName: 'Mahmoud' }), 'Amr Mahmoud');
	assert.equal(displayNameOf({ firstName: 'عمرو', lastName: '' }), 'عمرو');
});
