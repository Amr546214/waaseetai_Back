import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRequestStage, offerActionBlock, REQUEST_STAGE_GROUP, REQUEST_STAGE_LABEL, type RequestStage } from './request-lifecycle';
import { createClientRequestSchema } from '../dtos/create-client-request.dto';

const stage = (requestStatus: string, contractStatus?: string | null, offerStatuses: string[] = []) => deriveRequestStage({ requestStatus, contractStatus, offerStatuses });

test('stage: open without offers / with offers / under negotiation', () => {
	assert.equal(stage('OPEN'), 'OPEN');
	assert.equal(stage('OPEN', null, ['REJECTED', 'CANCELLED']), 'OPEN');
	assert.equal(stage('OPEN', null, ['SUBMITTED']), 'OFFERS_RECEIVED');
	assert.equal(stage('OPEN', null, ['SUBMITTED', 'UNDER_NEGOTIATION']), 'UNDER_NEGOTIATION');
});

test('stage: an offer was selected - waiting for signature / funding / provider; never ACTIVE before the contract is active', () => {
	assert.equal(stage('PENDING_SIGNATURE', 'PENDING_CLIENT_SIGNATURE'), 'AWAITING_CLIENT_SIGNATURE');
	assert.equal(stage('PENDING_SIGNATURE', null), 'AWAITING_CLIENT_SIGNATURE');
	assert.equal(stage('PENDING_SIGNATURE', 'PENDING_PAYMENT'), 'AWAITING_FUNDING');
	assert.equal(stage('PENDING_SIGNATURE', 'PENDING_PROVIDER_SIGNATURE'), 'AWAITING_PROVIDER_SIGNATURE');
	assert.equal(stage('IN_PROGRESS', 'PENDING_PAYMENT'), 'AWAITING_FUNDING');
	assert.equal(stage('IN_PROGRESS', 'ACTIVE'), 'ACTIVE');
});

test('stage: terminal states and disputes', () => {
	assert.equal(stage('DRAFT'), 'DRAFT');
	assert.equal(stage('CANCELLED', 'ACTIVE'), 'CANCELLED');
	assert.equal(stage('COMPLETED'), 'COMPLETED');
	assert.equal(stage('IN_PROGRESS', 'DISPUTED'), 'DISPUTED');
});

test('every stage has an Arabic label and exactly one list group; only ACTIVE and DISPUTED are "active"', () => {
	const stages = Object.keys(REQUEST_STAGE_LABEL) as RequestStage[];
	for (const s of stages) { assert.ok(REQUEST_STAGE_LABEL[s]); assert.ok(REQUEST_STAGE_GROUP[s]); }
	assert.deepEqual(stages.filter(s => REQUEST_STAGE_GROUP[s] === 'active').sort(), ['ACTIVE', 'DISPUTED']);
	assert.ok(stages.filter(s => s.startsWith('AWAITING')).every(s => REQUEST_STAGE_GROUP[s] === 'pending'));
});

test('offerActionBlock: null for a live offer on an open request, a reason otherwise', () => {
	for (const o of ['PENDING', 'SUBMITTED', 'UNDER_NEGOTIATION']) assert.equal(offerActionBlock('OPEN', o), null);
	assert.match(offerActionBlock('CANCELLED', 'SUBMITTED')!, /إلغاء/);
	assert.match(offerActionBlock('PENDING_SIGNATURE', 'PENDING_SIGNATURE')!, /ينتظر التوقيع/);
	assert.match(offerActionBlock('PENDING_SIGNATURE', 'SUBMITTED')!, /عرض آخر/);
	assert.match(offerActionBlock('OPEN', 'CANCELLED')!, /سحب/);
	assert.match(offerActionBlock('OPEN', 'REJECTED')!, /مغلق/);
	assert.match(offerActionBlock('OPEN', 'PENDING_SIGNATURE')!, /اختيار/);
	assert.equal(offerActionBlock(undefined, 'SUBMITTED'), null);
});

const valid = { specialtyId: 's1', title: 'تصميم شعار', description: 'وصف كافٍ للمشروع', budgetType: 'FIXED', minBudget: 500, maxBudget: 500, expectedDurationDays: 14 };
test('create request schema: valid data passes', () => {
	assert.equal(createClientRequestSchema.safeParse(valid).success, true);
	assert.equal(createClientRequestSchema.safeParse({ ...valid, budgetType: 'RANGE', minBudget: 100, maxBudget: 300 }).success, true);
});
for (const [name, patch] of [
	['no specialty', { specialtyId: undefined }],
	['no budget', { minBudget: null }],
	['zero budget', { minBudget: 0 }],
	['range max below min', { budgetType: 'RANGE', minBudget: 300, maxBudget: 100 }],
	['no duration', { expectedDurationDays: null }],
	['zero duration', { expectedDurationDays: 0 }],
	['short title', { title: 'ab' }],
	['short description', { description: 'قصير' }]
] as const) {
	test(`create request schema: ${name} is rejected (nothing is invented for it)`, () => {
		assert.equal(createClientRequestSchema.safeParse({ ...valid, ...patch }).success, false);
	});
}

test('a request closed by a dispute settlement is its own stage «أُغلق بتسوية نزاع» (closed group), never «مكتمل» — whatever the stored request / contract status is', () => {
	for (const [rs, cs] of [['COMPLETED', 'COMPLETED'], ['CANCELLED', 'CANCELLED'], ['COMPLETED', 'DISPUTED']] as const) {
		const got = deriveRequestStage({ requestStatus: rs, contractStatus: cs, offerStatuses: [], settled: true });
		assert.equal(got, 'CLOSED_BY_SETTLEMENT');
		assert.equal(REQUEST_STAGE_LABEL[got], 'أُغلق بتسوية نزاع');
		assert.equal(REQUEST_STAGE_GROUP[got], 'closed');
	}
	// not settled: unchanged
	assert.equal(deriveRequestStage({ requestStatus: 'COMPLETED', contractStatus: 'COMPLETED', offerStatuses: [] }), 'COMPLETED');
	assert.equal(deriveRequestStage({ requestStatus: 'IN_PROGRESS', contractStatus: 'ACTIVE', offerStatuses: [], settled: false }), 'ACTIVE');
});
