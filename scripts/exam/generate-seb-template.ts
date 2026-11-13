/**
 * Prints a Safe Exam Browser settings TEMPLATE for the exam owner (npx tsx scripts/exam/generate-seb-template.ts https://your.site > template.seb.plist).
 * It is a starting point for the SEB Config Tool, NOT the file users download and NOT evidence of anything: see utils/seb-exam.ts (SEB_TEMPLATE_KEY_NOTES) for what each key is based on.
 */
import { buildSebTemplate, SEB_TEMPLATE_KEY_NOTES } from '../../src/utils/seb-exam';

const origin = process.argv[2];
if (!origin || !/^https?:\/\//.test(origin)) { console.error('usage: generate-seb-template.ts <https://public-origin>'); process.exit(1); }
process.stdout.write(buildSebTemplate(new URL(origin).origin));
console.error('\nKey notes:\n' + Object.entries(SEB_TEMPLATE_KEY_NOTES).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
