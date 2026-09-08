import { AccountType, PrismaClient, UserStatus } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();

if (process.env.SEED_E2E !== 'true') {
  console.error('Set SEED_E2E=true to run local E2E seed');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL must be set before running the seed.');
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const clientEmail = 'client@test.com';
  const clientPassword = 'ClientTest12345';
  const providerEmail = 'provider@test.com';
  const providerPassword = 'ProviderTest12345';

  const clientHash = await bcrypt.hash(clientPassword, 12);
  const providerHash = await bcrypt.hash(providerPassword, 12);

  // --- Client ---
  const client = await prisma.user.upsert({
    where: { email: clientEmail },
    update: {
      password: clientHash,
      accountType: AccountType.CLIENT_INDIVIDUAL,
      status: UserStatus.ACTIVE,
      walletBalance: 10000,
    },
    create: {
      firstName: 'Test',
      lastName: 'Client',
      email: clientEmail,
      phoneNumber: '0500000001',
      phoneCountryCode: '+966',
      password: clientHash,
      accountType: AccountType.CLIENT_INDIVIDUAL,
      status: UserStatus.ACTIVE,
      roles: ['CLIENT'],
      activeRole: 'CLIENT',
      agreedToTerms: true,
      profileCompletionPercent: 100,
      walletBalance: 10000,
    },
  });

  await prisma.clientProfile.upsert({
    where: { userId: client.id },
    update: {},
    create: { userId: client.id },
  });

  // --- Provider ---
  const provider = await prisma.user.upsert({
    where: { email: providerEmail },
    update: {
      password: providerHash,
      accountType: AccountType.PROVIDER_INDIVIDUAL,
      status: UserStatus.ACTIVE,
    },
    create: {
      firstName: 'Test',
      lastName: 'Provider',
      email: providerEmail,
      phoneNumber: '0500000002',
      phoneCountryCode: '+966',
      password: providerHash,
      accountType: AccountType.PROVIDER_INDIVIDUAL,
      status: UserStatus.ACTIVE,
      roles: ['PROVIDER'],
      activeRole: 'PROVIDER',
      agreedToTerms: true,
      profileCompletionPercent: 100,
    },
  });

  await prisma.providerProfile.upsert({
    where: { userId: provider.id },
    update: {
      isVerified: true,
      kycStatus: 'VERIFIED',
      isNafathVerified: true,
      isProfileSetupComplete: true,
    },
    create: {
      userId: provider.id,
      isVerified: true,
      kycStatus: 'VERIFIED',
      isNafathVerified: true,
      isProfileSetupComplete: true,
    },
  });

  // --- Cleanup old non-UUID E2E service (if exists from previous seed runs) ---
  const oldService = await prisma.serviceCatalog.findUnique({ where: { id: 'e2e-service-0001' } });
  if (oldService) {
    await prisma.serviceStage.deleteMany({ where: { serviceId: 'e2e-service-0001' } });
    await prisma.serviceCatalog.delete({ where: { id: 'e2e-service-0001' } });
    console.log('Deleted old non-UUID E2E service: e2e-service-0001\n');
  }

  // --- Service Catalog (valid UUID required by cart validation) ---
  const E2E_SERVICE_ID = '11111111-1111-4111-8111-111111111111';
  const service = await prisma.serviceCatalog.upsert({
    where: { id: E2E_SERVICE_ID },
    update: {
      providerId: provider.id,
      title: 'خدمة اختبار E2E',
      description: 'خدمة تجريبية لاختبار checkout workspace lifecycle',
      totalAmount: 500,
      totalDays: 7,
      status: 'APPROVED',
      approvedAt: new Date(),
    },
    create: {
      id: E2E_SERVICE_ID,
      providerId: provider.id,
      title: 'خدمة اختبار E2E',
      description: 'خدمة تجريبية لاختبار checkout workspace lifecycle',
      totalAmount: 500,
      totalDays: 7,
      status: 'APPROVED',
      approvedAt: new Date(),
    },
  });

  // --- Service Stages ---
  const stageDefs = [
    { stepOrder: 1, title: 'التحليل والتجهيز', description: 'مرحلة التحليل والتجهيز', deliveryDays: 2, percentage: 30, computedAmount: 150 },
    { stepOrder: 2, title: 'التنفيذ', description: 'مرحلة التنفيذ', deliveryDays: 4, percentage: 50, computedAmount: 250 },
    { stepOrder: 3, title: 'التسليم النهائي', description: 'مرحلة التسليم النهائي', deliveryDays: 1, percentage: 20, computedAmount: 100 },
  ];

  for (const s of stageDefs) {
    const existing = await prisma.serviceStage.findFirst({
      where: { serviceId: service.id, stepOrder: s.stepOrder },
    });
    if (existing) {
      await prisma.serviceStage.update({
        where: { id: existing.id },
        data: {
          title: s.title,
          description: s.description,
          deliveryDays: s.deliveryDays,
          percentage: s.percentage,
          computedAmount: s.computedAmount,
        },
      });
    } else {
      await prisma.serviceStage.create({
        data: {
          serviceId: service.id,
          stepOrder: s.stepOrder,
          title: s.title,
          description: s.description,
          deliveryDays: s.deliveryDays,
          percentage: s.percentage,
          computedAmount: s.computedAmount,
        },
      });
    }
  }

  // --- Summary ---
  console.log('=== E2E Seed Complete ===\n');
  console.log(`Client:`);
  console.log(`  Email:    ${clientEmail}`);
  console.log(`  Password: ${clientPassword}`);
  console.log(`  ID:       ${client.id}`);
  console.log(`  Wallet:   10000 SAR\n`);
  console.log(`Provider:`);
  console.log(`  Email:    ${providerEmail}`);
  console.log(`  Password: ${providerPassword}`);
  console.log(`  ID:       ${provider.id}\n`);
  console.log(`Service:`);
  console.log(`  ID:       ${service.id}`);
  console.log(`  Title:    ${service.title}`);
  console.log(`  Status:   APPROVED`);
  console.log(`  Amount:   500 SAR`);
  console.log(`  Days:     7`);
  console.log(`  Stages:   3\n`);
  console.log(`Admin (existing):`);
  console.log(`  Email:    ${process.env.SEED_ADMIN_EMAIL || 'admin@test.com'}`);
  console.log(`  Password: ${process.env.SEED_ADMIN_PASSWORD || 'AdminTest12345'}\n`);
}

main()
  .catch((error) => {
    console.error('E2E seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
