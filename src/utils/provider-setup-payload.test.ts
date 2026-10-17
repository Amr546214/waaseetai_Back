import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isProviderSetupComplete } from './provider-setup-payload';
import { isBlankText } from './sanitize-text';

const complete = { headline: 'مطور ويب', country: 'SA', city: 'الرياض', bio: 'نبذة', mainSpecialty: 'dev', yearsOfExperience: 3, accurateAgreed: true, termsAgreed: true, privacyAgreed: true };

describe('required job title / bio: whitespace-only is not "filled"', () => {
	it('isBlankText: empty, spaces, NBSP, zero-width are blank; real text is not', () => {
		for (const v of ['', '   ', '  ', '​', ' ​‌‍﻿ ', '\t\n', null, undefined]) assert.equal(isBlankText(v), true, JSON.stringify(v));
		for (const v of ['a', ' a ', 'مطور']) assert.equal(isBlankText(v), false, v);
	});
	it('the setup stays incomplete when the job title or the bio is only whitespace / invisible characters', () => {
		assert.equal(isProviderSetupComplete(complete), true);
		for (const blank of ['   ', ' ', '​', ' ​ ']) {
			assert.equal(isProviderSetupComplete({ ...complete, headline: blank }), false, `headline ${JSON.stringify(blank)}`);
			assert.equal(isProviderSetupComplete({ ...complete, bio: blank }), false, `bio ${JSON.stringify(blank)}`);
		}
	});
});
