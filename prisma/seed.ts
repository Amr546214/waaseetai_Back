import { AccountType, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { prisma } from '../src/config/db';

async function main() {
  const email = 'simrami.dev@gmail.com';
  const plainPassword = 'Mrami1902@';

  console.log('Seeding SUPER_ADMIN user...');

  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    console.log(`User with email ${email} already exists.`);
    
    // Optionally, if the user exists but you want to ensure the role and password are correct:
    const hashedPassword = await bcrypt.hash(plainPassword, 10);
    const updatedUser = await prisma.user.update({
      where: { email },
      data: {
        password: hashedPassword,
        accountType: AccountType.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
    console.log(`Updated existing user ${email} to SUPER_ADMIN.`);
    return;
  }

  const hashedPassword = await bcrypt.hash(plainPassword, 10);

  const superAdmin = await prisma.user.create({
    data: {
      firstName: 'Mohamed',
      lastName: 'Rami',
      email: email,
      phoneNumber: '000000000', // Unique placeholder for super admin
      phoneCountryCode: '+212', // Assuming Morocco for the author, or use +966
      password: hashedPassword,
      accountType: AccountType.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      agreedToTerms: true,
      profileCompletionPercent: 100,
    },
  });

  console.log('Successfully created SUPER_ADMIN:');
  console.log(`Email: ${superAdmin.email}`);
  console.log(`Role: ${superAdmin.accountType}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
