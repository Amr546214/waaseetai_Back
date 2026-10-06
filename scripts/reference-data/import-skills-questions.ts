/**
 * NOT EXECUTED — written locally only. The team runs this on the server.
 *
 * Imports the JSON produced by export-skills-questions.ts into the database in
 * DATABASE_URL. Run it AFTER `npm run seed:taxonomy` (questions need their
 * specialties to exist).
 *
 * - Questions are linked to specialties by Specialty.slug, never by id. A question
 *   whose slug is missing in the target is skipped and reported (nothing is created
 *   for it), and the process exits non-zero so it isn't missed.
 * - Idempotent: Skill is upserted on its unique `name`; a Question is identified by
 *   (specialtyId, text) and created only if absent. Existing rows are never updated
 *   or deleted, so re-running changes nothing.
 * - Pass --dry-run to only report what would be created (no writes).
 *
 * Usage: npx tsx scripts/reference-data/import-skills-questions.ts <file.json> [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { PrismaClient, Prisma } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL must be set.');

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

interface ExportFile {
  version: number;
  skills: { name: string; category: string | null }[];
  questions: {
    specialtySlug: string; subSpecialtyTag: string | null; text: string; options: Prisma.JsonValue;
    correctOptionIndex: number; explanation: string | null; isActive: boolean;
  }[];
}

async function main() {
  const file = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!file) throw new Error('Usage: import-skills-questions.ts <file.json> [--dry-run]');

  const data = JSON.parse(readFileSync(file, 'utf8')) as ExportFile;
  if (data.version !== 1) throw new Error(`Unsupported export version ${data.version}`);

  let skillsCreated = 0;
  for (const s of data.skills) {
    const exists = await prisma.skill.findUnique({ where: { name: s.name }, select: { id: true } });
    if (exists) continue;
    if (!dryRun) await prisma.skill.create({ data: { name: s.name, category: s.category } });
    skillsCreated++;
  }

  const specialties = await prisma.specialty.findMany({ select: { id: true, slug: true } });
  const idBySlug = new Map(specialties.map((s) => [s.slug, s.id]));

  let created = 0, existing = 0;
  const missingSlugs = new Set<string>();
  for (const q of data.questions) {
    const specialtyId = idBySlug.get(q.specialtySlug);
    if (!specialtyId) { missingSlugs.add(q.specialtySlug); continue; }
    const found = await prisma.question.findFirst({ where: { specialtyId, text: q.text }, select: { id: true } });
    if (found) { existing++; continue; }
    if (!dryRun) {
      await prisma.question.create({
        data: {
          specialtyId, subSpecialtyTag: q.subSpecialtyTag, text: q.text,
          options: q.options as Prisma.InputJsonValue, correctOptionIndex: q.correctOptionIndex,
          explanation: q.explanation, isActive: q.isActive,
        },
      });
    }
    created++;
  }

  console.log(`${dryRun ? '[dry-run] would create' : 'Created'}: ${skillsCreated} skills, ${created} questions (${existing} questions already present).`);
  if (missingSlugs.size) {
    console.error(`Skipped questions for unknown specialty slugs (run seed:taxonomy first?): ${[...missingSlugs].join(', ')}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
