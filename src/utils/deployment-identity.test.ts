import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOfficialDeployment, officialHosts } from './deployment-identity';

const E = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
test('official only when BOTH the deploy flag and the FRONTEND_URL host agree; every other combination fails closed', () => {
	assert.equal(isOfficialDeployment(E({ PLATFORM_DEPLOY_ENV: 'official', FRONTEND_URL: 'https://waseetai.com' })), true);
	assert.equal(isOfficialDeployment(E({ PLATFORM_DEPLOY_ENV: 'Official', FRONTEND_URL: 'https://www.waseetai.com/' })), true);
	assert.equal(isOfficialDeployment(E({ PLATFORM_DEPLOY_ENV: 'official', FRONTEND_URL: 'https://dev.waseetai.com' })), false, 'the flag copied to dev is not enough');
	assert.equal(isOfficialDeployment(E({ FRONTEND_URL: 'https://waseetai.com', NODE_ENV: 'production' })), false, 'the official host without the flag is not enough');
	assert.equal(isOfficialDeployment(E({ PLATFORM_DEPLOY_ENV: 'official' })), false);
	assert.equal(isOfficialDeployment(E({ PLATFORM_DEPLOY_ENV: 'official', FRONTEND_URL: 'nonsense' })), false);
	assert.equal(isOfficialDeployment(E({ PLATFORM_DEPLOY_ENV: 'official', FRONTEND_URL: 'https://waseetai.com.evil.test' })), false, 'a look-alike host never matches');
	assert.equal(isOfficialDeployment(E({ NODE_ENV: 'production', PLATFORM_DEPLOY_ENV: 'staging', FRONTEND_URL: 'https://waseetai.com' })), false);
});
test('OFFICIAL_HOSTS can extend the host list explicitly (comma separated, case-insensitive)', () => {
	assert.deepEqual(officialHosts(E({ OFFICIAL_HOSTS: ' A.com, B.com ' })), ['a.com', 'b.com']);
	assert.equal(isOfficialDeployment(E({ PLATFORM_DEPLOY_ENV: 'official', OFFICIAL_HOSTS: 'site.example', FRONTEND_URL: 'https://site.example' })), true);
});
