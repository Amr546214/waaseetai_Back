import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateProviderPreferencesSchema as s } from './provider-preferences.dto';

test('provider preferences schema', () => {
  assert.ok(s.safeParse({ preferredCommunicationLanguage: 'ar', timezone: 'Asia/Riyadh', notifChannels: ['email'] }).success);
  assert.ok(!s.safeParse({}).success);
  assert.ok(!s.safeParse({ preferredCommunicationLanguage: 'fr' }).success);
  assert.ok(!s.safeParse({ timezone: 'Mars/Base' }).success);
  assert.ok(!s.safeParse({ notifChannels: ['sms'] }).success);
});
