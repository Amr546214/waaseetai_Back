import dotenv from 'dotenv';
import path from 'path';

// Try loading env files
dotenv.config({ path: path.join(__dirname, '../../etc/waseetai/backend-dev.env') });
dotenv.config({ path: '/etc/waseetai/backend-dev.env' });
dotenv.config();

import { prisma } from '../src/config/db';
import { aiAuditService } from '../src/services/ai-audit.service';

async function runRetroactiveAudit() {
  console.log('🔍 Starting retroactive AI Audit for existing business models...');
  
  try {
    const pendingModels = await prisma.serviceCatalog.findMany({
      where: {
        status: { in: ['PENDING_APPROVAL', 'UNDER_REVIEW', 'DRAFT'] as any }
      },
      include: {
        stages: true,
        provider: true
      }
    });

    console.log(`📦 Found ${pendingModels.length} models waiting for audit.`);

    if (pendingModels.length === 0) {
      console.log('ℹ️ No pending models found in database to audit.');
      // Let's also check if there are any models at all in the db just to report
      const allModelsCount = await prisma.serviceCatalog.count();
      console.log(`📊 Total business models currently in database across all statuses: ${allModelsCount}`);
      await prisma.$disconnect();
      process.exit(0);
    }

    for (const model of pendingModels) {
      console.log(`\n🤖 Auditing model [${model.id}] "${model.title}" (Provider: ${model.providerId})...`);
      const result = await aiAuditService.executeAuditSync(model.id, model.providerId);
      if (result) {
        console.log(`✅ Completed audit for model [${model.id}] -> Status: ${result.status}, AI Score: ${result.auditResult.overallScore}%`);
      } else {
        console.warn(`⚠️ Failed to complete audit for model [${model.id}]`);
      }
    }

    console.log('\n🎉 Retroactive AI Audit completed successfully!');
    const updatedModels = await prisma.serviceCatalog.findMany({
      where: { id: { in: pendingModels.map(m => m.id) } },
      select: { id: true, title: true, status: true, aiScore: true }
    });
    console.table(updatedModels);

    await prisma.$disconnect();
    process.exit(0);

  } catch (error) {
    console.error('❌ Fatal error running retroactive AI Audit:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

runRetroactiveAudit();
