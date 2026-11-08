import { prisma } from '../config/db';
import { checkCaseSlaReadiness } from '../services/case-sla.service';

void checkCaseSlaReadiness().then(result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.state === 'invalid' || result.state === 'ineligible') process.exitCode = 1;
}).catch(() => {
  process.stderr.write('Could not check case escalation readiness. Verify database access.\n');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
