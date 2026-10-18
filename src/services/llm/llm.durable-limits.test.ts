import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DurableLlmLimits, getDurableLlmGuard, type DurableLlmReservation } from './llm.durable-limits';
import { LlmError, LlmErrorCode } from './llm.errors';

const testRoot = resolve('C:/Users/DELL/Documents/Codex/2026-10-12/ht/work/guard-tests');
let directory: string, filename: string, now: number;
let guards: DurableLlmLimits[];
const policy = (overrides: Partial<DurableLlmReservation> = {}): DurableLlmReservation => ({
  userId:'private-user-a',feature:'delivery-review',ratePerHour:10,monthlyBudgetUsd:0.002,
  priceInputPerMillionUsd:1,priceOutputPerMillionUsd:1,maxTokensIn:1000,maxTokensOut:1000,leaseMs:30_000,...overrides,
});
const guard = () => { const instance = new DurableLlmLimits({driver:'sqlite',filename,now:() => now}); guards.push(instance); return instance; };
const code = (expected: LlmErrorCode) => (error:unknown) => error instanceof LlmError && error.code === expected;

beforeEach(() => { mkdirSync(testRoot,{recursive:true}); directory=mkdtempSync(join(testRoot,'guard-'));filename=join(directory,'limits.sqlite');now=Date.UTC(2026,9,12,12);guards=[]; });
afterEach(async () => { for(const instance of guards) await instance.close();const absolute=resolve(directory);if(!absolute.startsWith(testRoot+sep))throw new Error('test cleanup path escaped work directory');rmSync(absolute,{recursive:true,force:true}); });

test('reserves the maximum cost before execution and keeps it across restart',async () => {
  const first=guard(); await first.reserve(policy()); await first.close();guards=[];
  const restarted=guard(); await assert.rejects(restarted.reserve(policy({userId:'user-b'})),code(LlmErrorCode.BUDGET_EXCEEDED));
});

test('concurrent connections allow only one user-feature lease',async () => {
  const left=guard(),right=guard();const results=await Promise.allSettled([left.reserve(policy()),right.reserve(policy())]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const failed=results.find(result=>result.status==='rejected') as PromiseRejectedResult;assert.equal(failed.reason.code,LlmErrorCode.BUSY);
});

test('settles measured usage exactly once and releases unspent reservation',async () => {
  const instance=guard(),reservation=await instance.reserve(policy());
  await instance.settle(reservation.id,{tokensIn:250,tokensOut:250,measured:true,attempted:true});
  await instance.settle(reservation.id,{tokensIn:1000,tokensOut:1000,measured:true,attempted:true});
  await instance.reserve(policy({userId:'user-b',maxTokensIn:750,maxTokensOut:750}));
  await assert.rejects(instance.reserve(policy({userId:'user-c',maxTokensIn:1,maxTokensOut:1})),code(LlmErrorCode.BUDGET_EXCEEDED));
});

test('unknown attempted usage charges the entire bound and expired crash leases remain charged',async () => {
  const instance=guard(),reservation=await instance.reserve(policy());
  await instance.settle(reservation.id,{tokensIn:1,tokensOut:1,measured:false,attempted:true});
  await assert.rejects(instance.reserve(policy({userId:'user-b'})),code(LlmErrorCode.BUDGET_EXCEEDED));
  now+=3_600_001;
  await assert.rejects(instance.reserve(policy()),code(LlmErrorCode.BUDGET_EXCEEDED));
});

test('a cancelled request that never attempted a provider call releases cost but still counts rate',async () => {
  const instance=guard(),reservation=await instance.reserve(policy({ratePerHour:1}));
  await instance.settle(reservation.id,{tokensIn:0,tokensOut:0,measured:false,attempted:false});
  await assert.rejects(instance.reserve(policy({ratePerHour:1})),code(LlmErrorCode.RATE_LIMITED));
  await instance.reserve(policy({userId:'user-b'}));
});

test('crash expiry unlocks concurrency without silently refunding unknown spend',async () => {
  const instance=guard();await instance.reserve(policy());now+=30_001;
  await assert.rejects(instance.reserve(policy()),code(LlmErrorCode.BUDGET_EXCEEDED));
  now=Date.UTC(2026,10,1);await instance.reserve(policy());
});

test('rate state survives restart and is separate by actor and feature',async () => {
  const first=guard(),reservation=await first.reserve(policy({ratePerHour:1,monthlyBudgetUsd:null}));
  await first.settle(reservation.id,{tokensIn:0,tokensOut:0,measured:true,attempted:false});await first.close();guards=[];
  const restarted=guard();await assert.rejects(restarted.reserve(policy({ratePerHour:1,monthlyBudgetUsd:null})),code(LlmErrorCode.RATE_LIMITED));
  await restarted.reserve(policy({ratePerHour:1,monthlyBudgetUsd:null,feature:'profile-bio'}));
  await restarted.reserve(policy({ratePerHour:1,monthlyBudgetUsd:null,userId:'user-b'}));
  const bytes=Buffer.concat(readdirSync(directory).map(name=>readFileSync(join(directory,name))));assert.equal(bytes.includes(Buffer.from('private-user-a')),false);
});

test('fails closed for a budget without prices and SQLite in production',async () => {
  await assert.rejects(guard().reserve(policy({priceInputPerMillionUsd:null})),code(LlmErrorCode.PROVIDER_UNAVAILABLE));
  assert.throws(()=>getDurableLlmGuard({NODE_ENV:'production',WASEET_AI_DURABLE_GUARDS:'sqlite',WASEET_AI_STATE_DIR:directory}),code(LlmErrorCode.PROVIDER_UNAVAILABLE));
  assert.throws(()=>getDurableLlmGuard({NODE_ENV:'production',WASEET_AI_DURABLE_GUARDS:'postgres'}),code(LlmErrorCode.PROVIDER_UNAVAILABLE));
});
