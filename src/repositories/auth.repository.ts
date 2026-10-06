import { OtpType, UserStatus, PrismaClient } from '@prisma/client';
import { OtpPurpose, type OtpPurposeValue } from '../utils/otp-purpose';
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
  public async createUserWithProfile(data: RegisterInput, hashedPassword: string | null, googleIdentity?: { sub: string; picture?: string }) {
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
          ...(googleIdentity ? {
            authProvider: 'google',
            googleId: googleIdentity.sub,
            avatarUrl: googleIdentity.picture
          } : {}),
          agreedToTerms: data.agreedToTerms as boolean,
          // Authentication is email-only: no SMS login verification exists, so a new account never enables it.
          phoneOtpEnabled: false
        }
      });

      // 2. Create a matching profile row for every owned role (shared with
      // googleAuth's new-user path via createMissingRoleProfiles, so they
      // can't diverge). Phase 3D.4: passes the full identity so seeded
      // display fields and initial completion are calculated from the same
      // real state everywhere — banking/KYC fields are null for a brand-new
      // registration, which the calculators already treat as "not scored".
      await createMissingRoleProfiles(tx, user.id, roles, {
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        email: user.email,
        phoneNumber: user.phoneNumber,
        idNumber: user.idNumber,
        idExpiryDate: user.idExpiryDate,
        ibanNumber: user.ibanNumber,
        bankName: user.bankName,
        accountHolderName: user.accountHolderName,
        idDocumentUrl: user.idDocumentUrl,
        accountType: user.accountType
      });

      return user;
    });
  }

  /**
   * Create an OTP record. `purpose` is mandatory and stored in `context.purpose`: a verification path accepts only its own purpose.
   */
  public async createOtp(userId: string, code: string, type: OtpType, expiresAt: Date, purpose: OtpPurposeValue) {
    return prisma.otpVerification.create({
      data: {
        userId,
        code,
        type,
        expiresAt,
        context: { purpose }
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
   * Find a user specifically by email for login.
   *
   * Phase 3C: also fetches the (small) display-name slice of each role profile
   * so callers can resolve firstName/lastName from the user's CURRENTLY ACTIVE
   * role via resolveActiveRoleDisplayFields, instead of always returning the
   * legacy User.firstName/lastName regardless of which role is active.
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
        avatarUrl: true,
        email: true,
        googleId: true,
        authProvider: true,
        phoneNumber: true,
        phoneCountryCode: true,
        phoneOtpEnabled: true,
        clientProfile: { select: { firstName: true, lastName: true, avatarUrl: true } },
        providerProfile: { select: { firstName: true, lastName: true, avatarUrl: true } },
        affiliateProfile: { select: { firstName: true, lastName: true, avatarUrl: true } }
      }
    });
  }

  /**
   * Find a user by id with the same shape as findByEmail, for the login-time
   * phone OTP verify/resend endpoints (which only have a userId from the
   * initial login response, not an email).
   */
  public async findByIdForSession(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        accountType: true,
        activeRole: true,
        roles: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneNumber: true,
        phoneCountryCode: true,
        phoneOtpEnabled: true,
        clientProfile: { select: { firstName: true, lastName: true, avatarUrl: true } },
        providerProfile: { select: { firstName: true, lastName: true, avatarUrl: true } },
        affiliateProfile: { select: { firstName: true, lastName: true, avatarUrl: true } }
      }
    });
  }

  /**
   * Create a password-reset OTP record. Uses the shared OtpVerification table,
   * scoped via context.purpose so it can never be confused with an EMAIL
   * activation OTP (every lookup filters on the purpose explicitly).
   */
  public async createPasswordResetOtp(userId: string, code: string, expiresAt: Date) {
    return prisma.otpVerification.create({
      data: {
        userId,
        code,
        type: OtpType.EMAIL,
        expiresAt,
        context: { purpose: OtpPurpose.PASSWORD_RESET }
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
        context: { path: ['purpose'], equals: OtpPurpose.PASSWORD_RESET }
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
        context: { path: ['purpose'], equals: OtpPurpose.PASSWORD_RESET }
      }
    });
  }

  /**
   * The latest ACTIVATION email OTP (purpose ACTIVATION only — never a password-reset, sensitive-change, checkout or legacy
   * purpose-less code), valid or expired; the caller checks expiresAt/attempts.
   */
  public async findLatestActivationOtp(userId: string) {
    return prisma.otpVerification.findFirst({
      where: { userId, type: OtpType.EMAIL, context: { path: ['purpose'], equals: OtpPurpose.ACTIVATION } },
      orderBy: { createdAt: 'desc' }
    });
  }

  /** Deletes only ACTIVATION email OTPs (leaves phone, password-reset and every other purpose alone). */
  public async deleteActivationOtps(userId: string) {
    return prisma.otpVerification.deleteMany({
      where: { userId, type: OtpType.EMAIL, context: { path: ['purpose'], equals: OtpPurpose.ACTIVATION } }
    });
  }

  /**
   * Find the most recent OTP of a given type for a user, regardless of the
   * code entered — used where the caller needs to compare the code itself
   * and increment attempts on a mismatch (mirrors findLatestPasswordResetOtp,
   * generalized to any OtpType instead of the EMAIL/PASSWORD_RESET context).
   */
  public async findLatestOtp(userId: string, type: OtpType) {
    return prisma.otpVerification.findFirst({
      where: { userId, type },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Delete all PHONE-type OTPs for a user (leaves EMAIL activation/reset OTPs
   * untouched).
   */
  public async deletePhoneOtps(userId: string) {
    return prisma.otpVerification.deleteMany({
      where: { userId, type: OtpType.PHONE }
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
