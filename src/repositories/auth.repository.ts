import { OtpType, UserStatus, PrismaClient } from '@prisma/client';
import { prisma } from '../config/db';
import { RegisterInput } from '../routes/auth/auth.schema';
import { getRoleFromAccountType, getInitialRolesForAccountType, createMissingRoleProfiles } from '../services/account-management.service';

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
    const roles = getInitialRolesForAccountType(data.accountType);

    return prisma.$transaction(async (tx) => {
      // 1. Create User
      const user = await tx.user.create({
        data: {
          accountType: data.accountType,
          // Initialize roles/activeRole from the chosen accountType at creation
          // time, instead of leaving the schema defaults (roles: [CLIENT],
          // activeRole: CLIENT) for every account type and relying on the
          // lazy self-healing in account-management.service.ts to fix it later.
          roles,
          activeRole: getRoleFromAccountType(data.accountType),
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          phoneCountryCode: data.phoneCountryCode,
          phoneNumber: data.phoneNumber,
          password: hashedPassword,
          agreedToTerms: data.agreedToTerms as boolean
        }
      });

      // 2. Create a matching profile row for every owned role (shared with
      // googleAuth's new-user path via createMissingRoleProfiles, so they
      // can't diverge).
      await createMissingRoleProfiles(tx, user.id, roles, {
        firstName: user.firstName,
        lastName: user.lastName
      });

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
        activeRole: true,
        roles: true,
        firstName: true,
        lastName: true,
        email: true,
        googleId: true,
        authProvider: true
      }
    });
  }

  /**
   * Create a password-reset OTP record. Uses the shared OtpVerification table,
   * scoped via context.purpose so it can never be confused with an EMAIL
   * activation OTP (findValidOtp/findValidResetOtp filter on this explicitly).
   */
  public async createPasswordResetOtp(userId: string, code: string, expiresAt: Date) {
    return prisma.otpVerification.create({
      data: {
        userId,
        code,
        type: OtpType.EMAIL,
        expiresAt,
        context: { purpose: 'PASSWORD_RESET' }
      }
    });
  }

  /**
   * Find the most recent password-reset OTP for a user (valid or expired —
   * callers check expiresAt/attempts themselves so they can return the right message).
   */
  public async findLatestPasswordResetOtp(userId: string) {
    return prisma.otpVerification.findFirst({
      where: {
        userId,
        type: OtpType.EMAIL,
        context: { path: ['purpose'], equals: 'PASSWORD_RESET' }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Delete all password-reset OTPs for a user (leaves activation OTPs untouched).
   */
  public async deletePasswordResetOtps(userId: string) {
    return prisma.otpVerification.deleteMany({
      where: {
        userId,
        type: OtpType.EMAIL,
        context: { path: ['purpose'], equals: 'PASSWORD_RESET' }
      }
    });
  }

  /**
   * Increment the attempt counter on a specific OTP record.
   */
  public async incrementOtpAttempts(otpId: string) {
    return prisma.otpVerification.update({
      where: { id: otpId },
      data: { attempts: { increment: 1 } }
    });
  }

  /**
   * Update a user's password hash.
   */
  public async updatePassword(userId: string, hashedPassword: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword }
    });
  }
}

export const authRepository = new AuthRepository();
