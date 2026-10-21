import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_SERVICE_ERRORS, knownServiceError, respondServiceError } from './known-service-errors';
import { AppError } from './app-error';

const res = () => { const r: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } }; return r; };
const ARABIC = /[؀-ۿ]/;

test('every known refusal has a status, an Arabic message that is not just "error", and no technical text', () => {
	for (const [code, e] of Object.entries(KNOWN_SERVICE_ERRORS)) {
		assert.match(e.message, ARABIC, code); assert.ok(e.message.length > 12, code); assert.doesNotMatch(e.message, /prisma|SELECT|stack|undefined|null/i, code);
		assert.ok([400, 404, 409, 429, 503].includes(e.status), code);
	}
});

test('a known code answers with its fixed code + Arabic message; details (409) are passed through; AppError keeps its own status, message and code', () => {
	const r = res(); respondServiceError(r, Object.assign(new Error('REQUEST_ALREADY_PENDING'), { details: [{ code: 'REQUEST_ALREADY_PENDING', requestId: 'x' }] }));
	assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'REQUEST_ALREADY_PENDING'); assert.match(r.body.message, ARABIC); assert.deepEqual(r.body.errors, [{ code: 'REQUEST_ALREADY_PENDING', requestId: 'x' }]);
	const a = knownServiceError(new AppError('ممنوع', 403, undefined, 'SOME_CODE'))!; assert.equal(a.status, 403); assert.equal(a.body.code, 'SOME_CODE');
});

test('an unknown error is NOT guessed at: it is not a known refusal (the caller answers it as unexpected)', () => {
	assert.equal(knownServiceError(new Error('Invalid `prisma.user.update()` invocation')), null);
	assert.equal(knownServiceError(new Error('SOMETHING_NEW')), null);
	const r = res(); respondServiceError(r, new Error('Invalid `prisma.user.update()` invocation: SELECT ...'));
	assert.equal(r.statusCode, 500); // the safety net (safe-server-errors middleware) turns this body into the honest fixed message with a trace id
});
