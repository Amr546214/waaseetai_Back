import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The setup test and the later specialty test are ONE test: same question count, same time limit, same pass floor, from one constant. It proves a pass only.
process.env.JWT_SECRET = 'test-secret'; process.env.OPENAI_API_KEY = 'test-key';

test('both flows ask for 15 questions in 15 minutes and share the 25% pass floor, from one source', async () => {
	const c = await import('./specialty-test');
	assert.equal(c.SPECIALTY_TEST_QUESTION_COUNT, 15);
	assert.equal(c.SPECIALTY_TEST_TIME_LIMIT_MINUTES, 15);
	assert.equal(c.SPECIALTY_TEST_PASS_SCORE, 25);
	const root = join(__dirname, '..');
	const gateway = readFileSync(join(root, 'sockets/setup-test.gateway.ts'), 'utf8');
	const assessment = readFileSync(join(root, 'services/ai-assessment.service.ts'), 'utf8');
	for (const [name, src] of [['setup gateway', gateway], ['assessment service', assessment]] as const) {
		assert.match(src, /constants\/specialty-test/, `${name} imports the shared constants`);
		assert.doesNotMatch(src, /QUESTION_COUNT\s*=\s*\d+/, `${name} does not define its own number`);
		assert.doesNotMatch(src, /TIME_LIMIT_MINUTES\s*=\s*\d+/, `${name} does not define its own limit`);
	}
	assert.doesNotMatch(gateway, /SETUP_TEST_PASS_SCORE\s*=\s*\d+/);
});

test('no flow can ask the vendor for a different number: the exported aliases equal the shared constant', async () => {
	process.env.DATABASE_URL ??= 'postgresql://x:x@localhost/x';
	const [{ SETUP_TEST_QUESTION_COUNT, SETUP_TEST_TIME_LIMIT_MINUTES, SETUP_TEST_PASS_SCORE }, { ASSESSMENT_QUESTION_COUNT, ASSESSMENT_TIME_LIMIT_MINUTES }, c] = await Promise.all([
		import('../sockets/setup-test.gateway'), import('../services/ai-assessment.service'), import('./specialty-test'),
	]);
	assert.equal(SETUP_TEST_QUESTION_COUNT, c.SPECIALTY_TEST_QUESTION_COUNT);
	assert.equal(ASSESSMENT_QUESTION_COUNT, c.SPECIALTY_TEST_QUESTION_COUNT);
	assert.equal(SETUP_TEST_TIME_LIMIT_MINUTES, ASSESSMENT_TIME_LIMIT_MINUTES);
	assert.equal(SETUP_TEST_PASS_SCORE, c.SPECIALTY_TEST_PASS_SCORE);
});
