import { AccountType, OtpType, UserStatus, PrismaClient } from '@prisma/client';
import { prisma } from '../config/db';
import { RegisterInput } from '../routes/auth/auth.schema';

export class AuthRepository {
  /**
   * Find a user by either email or phone number
   */
  public async findByEmailOrPhone(email: string, phoneNumber: string) {
    return prisma.user.findFirst({
      where: {
        OR: [{ email }, { phoneNumber }]
      }
    });
  }

  /**
   * Find a user by id
   */
  public async findById(id: string) {
    return prisma.user.findUnique({
      where: { id }
    });
  }

  /**
   * Create User and their corresponding Profile in a Transaction
   */
  public async createUserWithProfile(data: RegisterInput, hashedPassword: string) {
    return prisma.$transaction(async (tx) => {
      // 1. Create User
      const user = await tx.user.create({
        data: {
          accountType: data.accountType,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          phoneCountryCode: data.phoneCountryCode,
          phoneNumber: data.phoneNumber,
          password: hashedPassword,
          agreedToTerms: data.agreedToTerms as boolean
        }
      });

      // 2. Create appropriate Profile
      if (
        data.accountType === AccountType.CLIENT_COMPANY ||
        data.accountType === AccountType.CLIENT_INDIVIDUAL
      ) {
        await tx.clientProfile.create({
          data: {
            userId: user.id
          }
        });
      } else if (
        data.accountType === AccountType.PROVIDER_COMPANY ||
        data.accountType === AccountType.PROVIDER_INDIVIDUAL ||
        data.accountType === AccountType.MARKETING_BROKER
      ) {
        await tx.providerProfile.create({
          data: {
            userId: user.id
          }
        });
      }

      return user;
    });
  }

  /**
   * Create an OTP record
   */
  public async createOtp(userId: string, code: string, type: OtpType, expiresAt: Date) {
    return prisma.otpVerification.create({
      data: {
        userId,
        code,
        type,
        expiresAt
      }
    });
  }

  /**
   * Find a specific active OTP record
   */
  public async findValidOtp(userId: string, code: string, type?: OtpType) {
    return prisma.otpVerification.findFirst({
      where: {
        userId,
        code,
        ...(type && { type })
      }
    });
  }

  /**
   * Update the user's global status
   */
  public async updateUserStatus(userId: string, status: UserStatus) {
    return prisma.user.update({
      where: { id: userId },
      data: { status }
    });
  }

  /**
   * Clean up all OTPs for a user
   */
  public async deleteUserOtps(userId: string) {
    return prisma.otpVerification.deleteMany({
      where: { userId }
    });
  }

  /**
   * Find a user specifically by email for login
   */
  public async findByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        password: true,
        status: true,
        accountType: true,
        firstName: true,
        lastName: true,
        email: true,
        googleId: true,
        authProvider: true
      }
    });
  }
}

export const authRepository = new AuthRepository();
