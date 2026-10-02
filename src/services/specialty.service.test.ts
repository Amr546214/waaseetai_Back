import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specialtyService } from './specialty.service';

// Final AI cleanup batch: executeAiAudit() previously fabricated a fixed
// { aiScore: 89.5, feasibilityScore: 92.0, clarityScore: 86.0,
// ownershipCredibility: 91.0 } result (plus a canned aiFeedback object) on
// every call, with no real analysis, and persisted it as if it were a real
// evaluation. Removed entirely along with its controller/route (the real
// wizard flow only ever called aiEvaluate(), never this dead HTTP twin).
// This guards against it silently reappearing.
test('specialtyService: the removed fake executeAiAudit method must never reappear', () => {
  assert.equal((specialtyService as any).executeAiAudit, undefined);
});

// /api/specialties/public returned 500 because its _count selected a `tests`
// relation that no longer exists on Specialty. Every _count key must be a real
// relation field of the model.
test('specialtyService.getPublicSpecialties: _count only selects relations that exist on Specialty', async () => {
  const { Prisma } = await import('@prisma/client');
  const { prisma } = await import('../config/db');
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Specialty')!;
  const relations = new Set(model.fields.filter((f) => f.kind === 'object').map((f) => f.name));

  let captured: any;
  const svc = specialtyService as any;
  const origEnsure = svc.ensureDefaultData;
  const origFind = (prisma as any).specialty.findMany;
  svc.ensureDefaultData = async () => {};
  (prisma as any).specialty.findMany = async (args: any) => { captured = args; return []; };
  try {
    await specialtyService.getPublicSpecialties();
  } finally {
    svc.ensureDefaultData = origEnsure;
    (prisma as any).specialty.findMany = origFind;
  }

  const countKeys = Object.keys(captured.include._count.select);
  assert.ok(countKeys.length > 0);
  for (const k of countKeys) assert.ok(relations.has(k), `_count.select.${k} is not a Specialty relation`);
});
