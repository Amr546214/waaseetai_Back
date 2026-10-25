import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Currency consistency guard (replaces the old absolute "USD only" rule; policy: platform base currency is configurable - USD / SAR - while every amount keeps ITS OWN currency, nothing is summed
 * across currencies and nothing is relabelled). The guard is a RATCHET: it cannot make today's gaps worse, and it forces the phase-A decision on any new money field.
 *   1. Every model that already carries a currency column keeps it (a column can never be dropped quietly).
 *   2. A Float / Decimal money-looking field on a model WITHOUT a currency column must already be in the recorded baseline (the known debt of phases B-F). A NEW one fails: add the currency column.
 *   3. The literal 'USD' in production code cannot spread: per file it may not exceed the recorded baseline (each one is a place phases C-D will replace with the record's currency).
 *   4. The registry's allowed base currencies are exactly USD and SAR, default USD.
 * Regenerate the baseline ONLY on purpose: CURRENCY_BASELINE_UPDATE=1 npx tsx --test src/config/currency-consistency.guard.test.ts  (a reviewer sees the diff).
 */
const ROOT = path.join(__dirname, '..', '..');
const BASELINE = path.join(__dirname, 'currency-consistency.baseline.json');
const schema = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const MONEY = /(amount|price|budget|fee|balance|total|subtotal|discount|cost|payout|spend|gmv|gross|net)/i;
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(m => ({ name: m[1], body: m[2] }));
const fieldsOf = (body: string) => [...body.matchAll(/^[ ]{2}(\w+)[ \t]+(\w+)(\?|\[\])?[ \t]*(.*)$/gm)].map(f => ({ name: f[1], type: f[2], rest: f[4] }));
const hasCurrency = (body: string) => fieldsOf(body).some(f => f.name === 'currency');
const untracked = models.filter(m => !hasCurrency(m.body)).flatMap(m => fieldsOf(m.body).filter(f => (f.type === 'Float' || f.type === 'Decimal') && MONEY.test(f.name)).map(f => `${m.name}.${f.name}`)).sort();
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'testing' || e.name === 'e2e' ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.ts') && !/\.(test|spec|pgenv|testutil)\.ts$/.test(e.name) ? [path.join(d, e.name)] : []));
const literals: Record<string, number> = {};
for (const f of walk(path.join(ROOT, 'src'))) { const n = (fs.readFileSync(f, 'utf8').match(/['"]USD['"]/g) ?? []).length; if (n) literals[path.relative(path.join(ROOT, 'src'), f)] = n; }
const current = { moneyFieldsWithoutCurrency: untracked, usdLiteralsPerFile: literals };
if (process.env.CURRENCY_BASELINE_UPDATE === '1') fs.writeFileSync(BASELINE, JSON.stringify(current, null, 1) + '\n');
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as typeof current;

test('currency guard: the models that carry a currency keep it, and phase A tables have it', () => {
	const must = ['WalletTransaction', 'Withdrawal', 'CommissionLog', 'PaypalPayment', 'Project', 'ClientRequest', 'Proposal', 'ProjectProposal', 'ProposalMilestone', 'Contract', 'ProjectStage', 'Escrow', 'ProjectAmendment', 'ServiceCatalog', 'Order', 'Coupon'];
	for (const m of must) assert.ok(hasCurrency(models.find(x => x.name === m)!.body), `${m} must carry its own currency`);
	for (const m of ['WalletTransaction', 'Withdrawal', 'CommissionLog']) assert.match(models.find(x => x.name === m)!.body, /currency\s+String\s+@default\("USD"\)/, `${m}: the stale SAR default is gone`);
});
test('currency guard: no NEW money field without a currency (the known debt is the recorded baseline only)', () => {
	const added = current.moneyFieldsWithoutCurrency.filter(f => !base.moneyFieldsWithoutCurrency.includes(f));
	assert.deepEqual(added, [], `new money fields on models without a currency column: ${added.join(', ')} - add a currency column (design: CURRENCY-TRANSITION-DESIGN.md)`);
	const resolved = base.moneyFieldsWithoutCurrency.filter(f => !current.moneyFieldsWithoutCurrency.includes(f));
	assert.ok(true, `resolved since the baseline (shrink it): ${resolved.join(', ')}`);
});
test("currency guard: the literal 'USD' does not spread in production code (each is replaced by the record's currency in phases C-D)", () => {
	const worse = Object.entries(current.usdLiteralsPerFile).filter(([f, n]) => n > (base.usdLiteralsPerFile[f] ?? 0)).map(([f, n]) => `${f}: ${n} > ${base.usdLiteralsPerFile[f] ?? 0}`);
	assert.deepEqual(worse, [], `more 'USD' literals than the baseline: ${worse.join('; ')}`);
});
test('currency guard: the base-currency setting allows exactly USD and SAR, default USD, and its change is gated by the readiness check', async () => {
	const { SETTING_BY_KEY } = await import('./system-settings.registry'); const d = SETTING_BY_KEY.get('baseCurrency')!;
	assert.deepEqual(d.allowed, ['USD', 'SAR']); assert.equal(d.default, 'USD'); assert.equal(d.schema!.safeParse('EUR').success, false); assert.equal(d.write, 'SUPER');
	const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'system-settings.service.ts'), 'utf8'); assert.ok(svc.includes("changed.includes('baseCurrency')") && svc.includes('currencyReadiness'));
});
