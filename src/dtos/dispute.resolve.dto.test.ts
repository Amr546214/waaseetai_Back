import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDisputeSchema } from './dispute.dto';

const ok = (b: unknown) => resolveDisputeSchema.safeParse(b);
const msg = (b: unknown) => { const r = resolveDisputeSchema.safeParse(b); return r.success ? null : r.error.issues.map(i => `${i.path.join('.')}:${i.message}`); };

test('a preset or a custom Arabic decision resolves', () => {
	assert.equal(ok({ action: 'resolve', resolution: 'MUTUAL_CLOSE' }).success, true);
	assert.equal(ok({ action: 'resolve', resolution: 'إغلاق نزاع اختبار QA بالتراضي، دون أي تغيير مالي.' }).success, true);
	assert.equal(ok({ action: 'reject', resolution: 'نزاع غير مستوفٍ للشروط', resolutionNote: 'لا يوجد دليل كافٍ.' }).success, true);
});

test('an EMPTY note is no note (it used to fail with a generic error)', () => {
	const r = ok({ action: 'resolve', resolution: 'MUTUAL_CLOSE', resolutionNote: '' });
	assert.equal(r.success, true);
	assert.equal(r.success && r.data.resolutionNote, undefined);
	assert.equal(ok({ action: 'resolve', resolution: 'MUTUAL_CLOSE', resolutionNote: '   ' }).success, true);
});

test('each failing field names its own problem', () => {
	assert.deepEqual(msg({ action: 'resolve', resolution: 'x' }), ['resolution:اكتب قرار النزاع (حرفان على الأقل)']);
	assert.match(msg({ action: 'resolve', resolution: 'أ'.repeat(121) })![0], /الحد الأقصى 120 حرفًا/);
	assert.match(msg({ action: 'resolve', resolution: 'MUTUAL_CLOSE', resolutionNote: 'x' })![0], /الملاحظة قصيرة جدًا/);
	assert.match(msg({ action: 'resolve' })![0], /اكتب قرار النزاع/);
	assert.match(msg({ action: 'close', resolution: 'MUTUAL_CLOSE' })![0], /نوع القرار غير صالح/);
});

test('the controller answers the field-specific message, not one generic sentence', async () => {
	const src = (await import('node:fs')).readFileSync(new URL('../controllers/dispute.controller.ts', import.meta.url), 'utf8');
	assert.match(src, /parsed\.error\.issues\[0\]\?\.message/);
});
