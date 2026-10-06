/**
 * NOT EXECUTED — written locally only. The team runs this against DEV on the server.
 *
 * Exports reference data (Skill + Question) from the database in DATABASE_URL to a
 * JSON file. READ-ONLY: only findMany() calls, nothing is written to any database.
 * Skills and questions are exported WITHOUT their DB ids; each question is keyed to
 * its specialty by Specialty.slug, so the file is portable across databases.
 *
 * Usage (on the dev server):
 *   DATABASE_URL=... npx tsx scripts/reference-data/export-skills-questions.ts [out.json]
 * Default output: ./reference-skills-questions.json (contains no secrets, no user data;
 * review it before moving it anywhere).
 *
 * Next step on prod, AFTER `npm run seed:taxonomy`:
 *   npx tsx scripts/reference-data/import-skills-questions.ts ./reference-skills-questions.json
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL must be set.');

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const outPath = process.argv[2] || './reference-skills-questions.json';

  const skills = await prisma.skill.findMany({ select: { name: true, category: true }, orderBy: { name: 'asc' } });

  const questions = await prisma.question.findMany({
    select: {
      subSpecialtyTag: true, text: true, options: true, correctOptionIndex: true,
      explanation: true, isActive: true, specialty: { select: { slug: true } },
    },
    orderBy: [{ specialty: { slug: 'asc' } }, { createdAt: 'asc' }],
  });

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    skills,
    questions: questions.map(({ specialty, ...q }) => ({ specialtySlug: specialty.slug, ...q })),
  };

  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Exported ${skills.length} skills and ${questions.length} questions to ${outPath}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
