import { AccountType, PrismaClient, UserStatus } from '@prisma/client';
import bcrypt from 'bcrypt';

// Keep the seed self-contained so it also works in the production image.
// The production image intentionally does not contain the TypeScript src tree.
const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const plainPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !plainPassword) {
    throw new Error(
      'SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set before running the seed.',
    );
  }

  if (plainPassword.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must contain at least 12 characters.');
  }

  console.log(`Seeding SUPER_ADMIN user: ${email}`);

  const hashedPassword = await bcrypt.hash(plainPassword, 12);
  const superAdmin = await prisma.user.upsert({
    where: { email },
    update: {
      password: hashedPassword,
      accountType: AccountType.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
    },
    create: {
      firstName: 'Mohamed',
      lastName: 'Rami',
      email,
      phoneNumber: `seed-${Date.now()}`,
      phoneCountryCode: '+212',
      password: hashedPassword,
      accountType: AccountType.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      agreedToTerms: true,
      profileCompletionPercent: 100,
    },
  });

  console.log(`SUPER_ADMIN is ready: ${superAdmin.email}`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
