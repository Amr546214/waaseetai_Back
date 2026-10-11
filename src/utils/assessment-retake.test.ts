import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSESSMENT_MAX_ATTEMPTS_PER_30_DAYS, ASSESSMENT_RETAKE_COOLDOWN_HOURS, computeRetryWindow } from './assessment-retake';

const ago = (h: number) => new Date(Date.now() - h * 3600 * 1000);

test('no attempts: nothing to wait for', () => {
	assert.deepEqual(computeRetryWindow([]), { limitReached: false, retryAfterSeconds: 0 });
});
test('a recent attempt: the wait is the cooldown minus the time since it finished (completedAt wins over createdAt)', () => {
	const w = computeRetryWindow([{ completedAt: ago(2), createdAt: ago(5) }]);
	assert.ok(Math.abs(w.retryAfterSeconds - (ASSESSMENT_RETAKE_COOLDOWN_HOURS - 2) * 3600) < 5);
	assert.equal(w.limitReached, false);
});
test('after the cooldown there is no wait', () => {
	assert.equal(computeRetryWindow([{ completedAt: ago(ASSESSMENT_RETAKE_COOLDOWN_HOURS + 1), createdAt: ago(ASSESSMENT_RETAKE_COOLDOWN_HOURS + 2) }]).retryAfterSeconds, 0);
});
test('the attempt limit is reached at the configured count', () => {
	const many = Array.from({ length: ASSESSMENT_MAX_ATTEMPTS_PER_30_DAYS }, (_, i) => ({ createdAt: ago(100 + i) }));
	assert.equal(computeRetryWindow(many).limitReached, true);
	assert.equal(computeRetryWindow(many.slice(1)).limitReached, false);
});
