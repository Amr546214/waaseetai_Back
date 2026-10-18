import dotenv from 'dotenv';
import path from 'path';
import type { AiAuditOutcome } from '../src/services/ai-audit.service';

// Existing listings do not receive an audit simply because they are viewed.
// Preview the missing audits first; --execute is required to call AI or persist scores.
export function auditOptions(args: string[]) {
  const allowed = new Set(['--dry-run', '--execute', '--id', '--limit']);
  let id: string | undefined;
  let limit = 25;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!allowed.has(arg)) throw new Error(`Unknown option: ${arg}`);
    if (arg === '--id') {
      id = args[++i];
      if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('--id requires a service UUID.');
    }
    if (arg === '--limit') {
      const value = args[++i];
      limit = Number(value);
      if (!value || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer between 1 and 100.');
    }
  }
  if (args.includes('--dry-run') && args.includes('--execute')) throw new Error('Choose --dry-run or --execute.');
  return { execute: args.includes('--execute'), id, limit };
}

export async function auditExistingModels(
  db: { serviceCatalog: { findMany: (query: any) => Promise<any[]> } },
  audit: (id: string) => Promise<AiAuditOutcome>,
  args: string[],
  log: (value: unknown) => void = console.log,
) {
  const options = auditOptions(args);
  const models = await db.serviceCatalog.findMany({
    where: {
      status: { in: ['PENDING_APPROVAL', 'UNDER_REVIEW', 'DRAFT', 'PUBLISHED', 'APPROVED'] },
      aiAuditScore: null,
      ...(options.id ? { id: options.id } : {}),
    },
    select: { id: true, title: true, status: true, specialtyId: true },
    orderBy: { createdAt: 'asc' },
    take: options.limit,
  });
  const counts = { selected: models.length, audited: 0, skipped: 0, failed: 0 };
  for (const model of models) {
    if (!model.specialtyId) {
      counts.skipped++;
      log({ id: model.id, title: model.title, outcome: 'skipped', reason: 'NO_CATEGORY' });
      continue;
    }
    if (!options.execute) {
      log({ id: model.id, title: model.title, status: model.status, outcome: 'would-audit' });
      continue;
    }
    try {
      const result = await audit(model.id);
      if (result.outcome === 'audited') counts.audited++; else counts.skipped++;
      log(result);
    } catch (error) {
      counts.failed++;
      // Never print provider error text, credentials, or raw requests.
      log({ id: model.id, outcome: 'failed', code: (error as { code?: string })?.code || 'AUDIT_FAILED' });
    }
  }
  log({ mode: options.execute ? 'execute' : 'dry-run', ...counts });
  return counts;
}

async function main() {
  const args = process.argv.slice(2);
  auditOptions(args); // Reject invalid arguments before opening a database connection.
  dotenv.config({ path: path.join(__dirname, '../../etc/waseetai/backend-dev.env'), quiet: true });
  dotenv.config({ path: '/etc/waseetai/backend-dev.env', quiet: true });
  dotenv.config({ quiet: true });
  const { prisma } = await import('../src/config/db');
  try {
    // The AI module is loaded only for an explicitly requested execution.
    const audit = async (id: string) => {
      const { aiAuditService } = await import('../src/services/ai-audit.service');
      return aiAuditService.executeAuditSync(id);
    };
    const result = await auditExistingModels(prisma, audit, args);
    if (result.failed) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch(() => {
    console.error('Unable to inspect or audit existing models. No publication status is changed by this script.');
    process.exitCode = 1;
  });
}
