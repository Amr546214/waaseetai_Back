import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderDisplayIdentity } from './provider-display';

// Phase 3E.1: resolveProviderDisplayIdentity is a pure function (no Prisma,
// no DB, no dotenv, no service imports with side effects), so these tests
// run with zero mocking.

test('ProviderProfile identity wins over User identity when both are present', () => {
  const identity = resolveProviderDisplayIdentity({
    providerProfile: { firstName: 'Provider', lastName: 'Persona', avatarUrl: 'https://provider.example/a.png' },
    user: { firstName: 'Legacy', lastName: 'Name', avatarUrl: 'https://legacy.example/a.png' }
  });

  assert.equal(identity.firstName, 'Provider');
  assert.equal(identity.lastName, 'Persona');
  assert.equal(identity.fullName, 'Provider Persona');
  assert.equal(identity.avatarUrl, 'https://provider.example/a.png');
});

test('falls back to User identity field-by-field when the ProviderProfile value is null', () => {
  const identity = resolveProviderDisplayIdentity({
    providerProfile: { firstName: null, lastName: null, avatarUrl: null },
    user: { firstName: 'Legacy', lastName: 'Name', avatarUrl: 'https://legacy.example/a.png' }
  });

  assert.equal(identity.firstName, 'Legacy');
  assert.equal(identity.lastName, 'Name');
  assert.equal(identity.fullName, 'Legacy Name');
  assert.equal(identity.avatarUrl, 'https://legacy.example/a.png');
});

test('falls back to User identity when the ProviderProfile value is an empty string', () => {
  const identity = resolveProviderDisplayIdentity({
    providerProfile: { firstName: '', lastName: '', avatarUrl: '' },
    user: { firstName: 'Legacy', lastName: 'Name', avatarUrl: 'https://legacy.example/a.png' }
  });

  assert.equal(identity.firstName, 'Legacy');
  assert.equal(identity.lastName, 'Name');
  assert.equal(identity.avatarUrl, 'https://legacy.example/a.png');
});

test('mixed state: ProviderProfile firstName set, lastName/avatarUrl missing — resolves independently per field', () => {
  const identity = resolveProviderDisplayIdentity({
    providerProfile: { firstName: 'Provider', lastName: null, avatarUrl: undefined },
    user: { firstName: 'Legacy', lastName: 'Name', avatarUrl: 'https://legacy.example/a.png' }
  });

  assert.equal(identity.firstName, 'Provider');
  assert.equal(identity.lastName, 'Name');
  assert.equal(identity.fullName, 'Provider Name');
  assert.equal(identity.avatarUrl, 'https://legacy.example/a.png');
});

test('both sources empty -> empty strings and null avatar, never throws', () => {
  const identity = resolveProviderDisplayIdentity({ providerProfile: {}, user: {} });

  assert.equal(identity.firstName, '');
  assert.equal(identity.lastName, '');
  assert.equal(identity.fullName, '');
  assert.equal(identity.avatarUrl, null);
});
