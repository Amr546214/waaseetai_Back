import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProposalReview, proposalBudgetSuitability, proposalDeadlineSuitability, proposalRecommendationRanks } from './proposal-suitability';

const fit = { source: 'LLM' as const, overallFit: 'HIGH' as const, summary: 'مناسب تقنيًا', matchPoints: [{ text: 'React متطابقة', basedOn: ['project.requiredSkills', 'provider.skills'] }], gaps: [] };
const offer = (id: string, price = 100, days = 14) => ({ id, status: 'SUBMITTED', aiProviderFit: fit, aiQualityScore: 80,
  budgetSuitability: proposalBudgetSuitability(price, 80, 766, 'RANGE'), deadlineSuitability: proposalDeadlineSuitability(days, 14) });

test('budget comparison uses supplied bounds, never midpoint closeness or invented market prices', () => {
  assert.equal(proposalBudgetSuitability(80, 80, 766).status, 'WITHIN_RANGE');
  assert.equal(proposalBudgetSuitability(766, 80, 766).status, 'WITHIN_RANGE');
  assert.equal(proposalBudgetSuitability(79, 80, 766).status, 'BELOW_RANGE');
  assert.equal(proposalBudgetSuitability(767, 80, 766).status, 'ABOVE_RANGE');
  assert.equal(proposalBudgetSuitability(500, 500, null, 'FIXED').status, 'WITHIN_RANGE');
  assert.equal(proposalBudgetSuitability(501, 500, null, 'FIXED').status, 'ABOVE_RANGE');
  assert.equal(proposalBudgetSuitability(500, null, null).status, 'UNKNOWN');
  assert.equal(proposalBudgetSuitability(500, 700, 600).status, 'UNKNOWN');
});

test('deadline comparison keeps promised delivery separate from proof of feasibility', () => {
  assert.equal(proposalDeadlineSuitability(14, 14).status, 'WITHIN_DEADLINE');
  assert.equal(proposalDeadlineSuitability(7, 14).status, 'WITHIN_DEADLINE');
  assert.equal(proposalDeadlineSuitability(15, 14).status, 'EXCEEDS_DEADLINE');
  assert.equal(proposalDeadlineSuitability(null, 14).status, 'UNKNOWN');
  assert.equal(proposalDeadlineSuitability(14, null).status, 'UNKNOWN');
});

test('equally appropriate low and high prices get the same recommendation rank; conflicts and weak actual fit are distinct', () => {
  const weak = { ...offer('weak', 100), aiProviderFit: { ...fit, overallFit: 'LOW' as const } };
  const ranks = proposalRecommendationRanks([offer('more-expensive', 700), offer('lower-price', 100), offer('over-budget', 1000), offer('late', 100, 20), weak]);
  assert.equal(ranks.get('lower-price'), 1);
  assert.equal(ranks.get('more-expensive'), 1);
  assert.ok(ranks.get('over-budget')! > 1);
  assert.ok(ranks.get('late')! > 1);
  assert.ok(ranks.get('weak')! > ranks.get('late')!);
});

test('unknown or rejected offers are not given fabricated scores or recommendation ranks; empty requests stay empty', () => {
  const unknown = { ...offer('unknown'), aiProviderFit: null, aiQualityScore: null };
  const rejected = { ...offer('rejected'), status: 'REJECTED' };
  assert.deepEqual([...proposalRecommendationRanks([])], []);
  assert.deepEqual([...proposalRecommendationRanks([unknown, rejected])], []);
  assert.equal(unknown.aiQualityScore, null);
});

test('the stored review is sanitized; zero is valid quality and old midpoint-blended columns are not relabelled', () => {
  assert.deepEqual(readProposalReview({ source: 'WASEET_AI', qualityScore: 0, providerFit: { ...fit, secret: 'do not forward' } }), { qualityScore: 0, providerFit: fit });
  assert.deepEqual(readProposalReview({ source: 'WASEET_AI', summary: 'legacy', aiMatchScore: 88 }), { qualityScore: null, providerFit: null });
  assert.equal(readProposalReview({ source: 'WASEET_AI', qualityScore: 80, providerFit: { ...fit, source: 'FAKE' } }).providerFit, null);
});
