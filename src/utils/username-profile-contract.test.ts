import test from 'node:test';
import assert from 'node:assert/strict';
import { updateProfileSchema } from '../dtos/profile.dto';
import { updateBasicsSchema, updateContactSchema } from '../dtos/profile-tab.dto';

test('username profiles: legacy DTOs accept the intentionally empty surname without weakening validation of supplied names', () => {
  for (const schema of [updateProfileSchema, updateBasicsSchema, updateContactSchema]) {
    assert.equal(schema.safeParse({ firstName: 'عمرو', lastName: '' }).success, true);
    assert.equal(schema.safeParse({ firstName: 'عمرو', lastName: 'x' }).success, false);
    assert.equal(schema.safeParse({ firstName: 'عمرو', lastName: 123 }).success, false);
  }
});
