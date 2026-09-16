import {
  ChangeRequestStatus,
  ModificationStatus,
  SensitiveFieldType,
} from '@prisma/client';
import { prisma } from '../config/db';
import type {
  ProfileSensitiveChangeContext,
  ProfileSensitiveChangeDuplicateSignal,
  ProfileSensitiveChangeFieldType,
  ProfileSensitiveChangeValidationSignal,
} from '../modules/ai-engine';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const PROVIDER_PENDING_STATUSES = [
  ModificationStatus.PENDING_OTP,
  ModificationStatus.IN_AI_REVIEW,
  ModificationStatus.PENDING_HUMAN_REVIEW,
];

const AFFILIATE_PENDING_STATUSES = [
  ChangeRequestStatus.PENDING_AI_REVIEW,
  ChangeRequestStatus.PENDING_HUMAN_APPROVAL,
];

const PROVIDER_APPROVED_STATUSES = [ModificationStatus.APPROVED];
const AFFILIATE_APPROVED_STATUSES = [ChangeRequestStatus.APPROVED_AND_APPLIED];

type RawValueSource = string | Record<string, unknown> | null | undefined;

export interface ProfileSensitiveChangeContextBuildResult {
  context: ProfileSensitiveChangeContext;
  auditRefs: {
    requestId: string;
    userId: string;
    entityType: 'PROFILE_MODIFICATION_REQUEST' | 'PROFILE_CHANGE_REQUEST';
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const parseStoredRecord = (
  value: string | null | undefined
): Record<string, unknown> | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const hasValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasValue);
  if (isRecord(value)) return Object.values(value).some(hasValue);
  return true;
};

const valueFromSource = (
  source: RawValueSource,
  keys: string[]
): unknown => {
  if (isRecord(source)) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        return source[key];
      }
    }
    return undefined;
  }

  return source;
};

const normalizeFieldType = (
  fieldName: string | SensitiveFieldType | null | undefined,
  category?: string | null
): ProfileSensitiveChangeFieldType => {
  const field = String(fieldName || '').trim().toUpperCase();
  if (field === 'EMAIL') return 'EMAIL';
  if (field === 'PHONE_NUMBER' || field === 'PHONE') return 'PHONE_NUMBER';
  if (field === 'IBAN' || field === 'IBAN_NUMBER') return 'IBAN';
  if (field === 'NATIONAL_ID' || field === 'ID_NUMBER') return 'NATIONAL_ID';

  const normalizedCategory = String(category || '').trim().toUpperCase();
  if (normalizedCategory === 'CONTACT') return 'CONTACT';
  if (normalizedCategory === 'BANKING') return 'BANKING';
  if (normalizedCategory === 'DOCUMENTS') return 'DOCUMENTS';

  return 'UNKNOWN';
};

const keysForFieldType = (fieldType: ProfileSensitiveChangeFieldType): string[] => {
  if (fieldType === 'EMAIL') return ['email'];
  if (fieldType === 'PHONE_NUMBER') return ['phoneNumber', 'phone'];
  if (fieldType === 'IBAN') return ['ibanNumber', 'iban'];
  if (fieldType === 'NATIONAL_ID') return ['idNumber', 'nationalId'];
  if (fieldType === 'CONTACT') {
    return ['email', 'phoneNumber', 'alternativePhone'];
  }
  if (fieldType === 'BANKING') {
    return ['accountHolderName', 'accountHolder', 'bankName', 'ibanNumber', 'iban'];
  }
  if (fieldType === 'DOCUMENTS') {
    return [
      'idDocumentUrl',
      'certificatesUrl',
      'commercialRegistration',
      'vatCertificateUrl',
    ];
  }

  return [];
};

const normalizedEmail = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email || null;
};

const normalizedPhone = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const phone = value.replace(/[\s()-]/g, '');
  return phone || null;
};

const isEmailFormatValid = (value: unknown): boolean => {
  const email = normalizedEmail(value);
  return Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
};

const isPhoneFormatValid = (value: unknown): boolean => {
  const phone = normalizedPhone(value);
  return Boolean(phone && /^\+?\d{8,15}$/.test(phone));
};

const isHttpsUrl = (value: unknown): boolean => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const documentValues = (source: RawValueSource): unknown[] => {
  if (!isRecord(source)) return [];
  return keysForFieldType('DOCUMENTS')
    .map(key => source[key])
    .filter(hasValue);
};

const deterministicFormatSignal = (
  fieldType: ProfileSensitiveChangeFieldType,
  requestedSource: RawValueSource
): ProfileSensitiveChangeValidationSignal => {
  if (fieldType === 'EMAIL') {
    return isEmailFormatValid(valueFromSource(requestedSource, ['email']));
  }
  if (fieldType === 'PHONE_NUMBER') {
    return isPhoneFormatValid(
      valueFromSource(requestedSource, ['phoneNumber', 'phone'])
    );
  }
  if (fieldType === 'CONTACT' && isRecord(requestedSource)) {
    const checks: boolean[] = [];
    if (hasValue(requestedSource.email)) {
      checks.push(isEmailFormatValid(requestedSource.email));
    }
    if (hasValue(requestedSource.phoneNumber)) {
      checks.push(isPhoneFormatValid(requestedSource.phoneNumber));
    }
    if (hasValue(requestedSource.alternativePhone)) {
      checks.push(isPhoneFormatValid(requestedSource.alternativePhone));
    }
    return checks.length > 0 ? checks.every(Boolean) : 'unavailable';
  }
  if (fieldType === 'DOCUMENTS') {
    const values = documentValues(requestedSource);
    return values.length > 0 ? values.every(isHttpsUrl) : 'unavailable';
  }

  return 'unavailable';
};

const documentPresentSignal = (
  fieldType: ProfileSensitiveChangeFieldType,
  requestedSource: RawValueSource
): ProfileSensitiveChangeValidationSignal => {
  if (fieldType !== 'DOCUMENTS') return 'unavailable';
  return documentValues(requestedSource).length > 0;
};

const documentTransportSignal = (
  fieldType: ProfileSensitiveChangeFieldType,
  requestedSource: RawValueSource
): ProfileSensitiveChangeValidationSignal => {
  if (fieldType !== 'DOCUMENTS') return 'unavailable';
  const values = documentValues(requestedSource);
  return values.length > 0 ? values.every(isHttpsUrl) : 'unavailable';
};

const ageDays = (createdAt: Date, now: Date): number => {
  const age = Math.floor((now.getTime() - createdAt.getTime()) / MS_PER_DAY);
  return Number.isFinite(age) ? Math.max(0, age) : 0;
};

const ageBucket = (
  days: number
): ProfileSensitiveChangeContext['account']['ageBucket'] => {
  if (days < 30) return 'under_30_days';
  if (days <= 180) return '30_to_180_days';
  return 'over_180_days';
};

export class ProfileIntelligenceContextService {
  async buildProviderModificationRequestContext(
    requestId: string,
    now: Date = new Date()
  ): Promise<ProfileSensitiveChangeContextBuildResult> {
    const request = await prisma.profileModificationRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        providerId: true,
        category: true,
        fieldName: true,
        currentValue: true,
        requestedValue: true,
        status: true,
        requiresOtp: true,
        otpVerifiedAt: true,
        metadata: true,
        provider: {
          select: {
            accountType: true,
            status: true,
            createdAt: true,
            providerProfile: {
              select: {
                isVerified: true,
                isNafathVerified: true,
                kycStatus: true,
              },
            },
          },
        },
      },
    });

    if (!request) throw new Error('PROFILE_MODIFICATION_REQUEST_NOT_FOUND');
    if (request.status !== ModificationStatus.PENDING_HUMAN_REVIEW) {
      throw new Error('PROFILE_MODIFICATION_REQUEST_NOT_PENDING_HUMAN_REVIEW');
    }

    const metadata = isRecord(request.metadata) ? request.metadata : {};
    const metadataChanges = isRecord(metadata.changes) ? metadata.changes : null;
    const fieldType = normalizeFieldType(request.fieldName, request.category);
    const currentSource = parseStoredRecord(request.currentValue) ?? request.currentValue;
    const requestedSource =
      metadataChanges ?? parseStoredRecord(request.requestedValue) ?? request.requestedValue;
    const duplicateCheck = await this.duplicateCheck(
      fieldType,
      requestedSource,
      request.providerId
    );
    const accountAgeDays = ageDays(request.provider.createdAt, now);

    const context: ProfileSensitiveChangeContext = {
      request: {
        kind: 'provider_profile_modification',
        category: request.category,
        fieldType,
        requesterAccountType: request.provider.accountType,
        existingValuePresent: hasValue(
          valueFromSource(currentSource, keysForFieldType(fieldType))
        ),
        requestedValuePresent: hasValue(
          valueFromSource(requestedSource, keysForFieldType(fieldType))
        ),
        otpVerified: Boolean(request.otpVerifiedAt),
        humanReviewRequired: true,
      },
      validation: {
        formatValid: deterministicFormatSignal(fieldType, requestedSource),
        duplicateCheck,
        documentPresent: documentPresentSignal(fieldType, requestedSource),
        documentTransportValid: documentTransportSignal(fieldType, requestedSource),
        requiredVerificationPresent: Boolean(request.otpVerifiedAt),
      },
      account: {
        status: request.provider.status,
        ageDays: accountAgeDays,
        ageBucket: ageBucket(accountAgeDays),
        profileVerified: Boolean(request.provider.providerProfile?.isVerified),
        nafathVerified: Boolean(request.provider.providerProfile?.isNafathVerified),
        kycStatus: request.provider.providerProfile?.kycStatus ?? null,
      },
      history: await this.providerHistory(request.providerId, request.id),
    };

    return {
      context,
      auditRefs: {
        requestId: request.id,
        userId: request.providerId,
        entityType: 'PROFILE_MODIFICATION_REQUEST',
      },
    };
  }

  async buildAffiliateProfileChangeRequestContext(
    requestId: string,
    now: Date = new Date()
  ): Promise<ProfileSensitiveChangeContextBuildResult> {
    const request = await prisma.profileChangeRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        affiliateProfileId: true,
        fieldType: true,
        currentValue: true,
        requestedValue: true,
        status: true,
        affiliateProfile: {
          select: {
            userId: true,
            identityVerified: true,
            user: {
              select: {
                accountType: true,
                status: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });

    if (!request) throw new Error('PROFILE_CHANGE_REQUEST_NOT_FOUND');
    if (request.status !== ChangeRequestStatus.PENDING_HUMAN_APPROVAL) {
      throw new Error('PROFILE_CHANGE_REQUEST_NOT_PENDING_HUMAN_APPROVAL');
    }

    const fieldType = normalizeFieldType(request.fieldType, 'BANKING');
    const currentSource = request.currentValue;
    const requestedSource = request.requestedValue;
    const accountAgeDays = ageDays(request.affiliateProfile.user.createdAt, now);

    const context: ProfileSensitiveChangeContext = {
      request: {
        kind: 'affiliate_profile_change',
        category: 'BANKING',
        fieldType,
        requesterAccountType: request.affiliateProfile.user.accountType,
        existingValuePresent: hasValue(currentSource),
        requestedValuePresent: hasValue(requestedSource),
        otpVerified: false,
        humanReviewRequired: true,
      },
      validation: {
        formatValid: deterministicFormatSignal(fieldType, requestedSource),
        duplicateCheck: 'unavailable',
        documentPresent: 'unavailable',
        documentTransportValid: 'unavailable',
        requiredVerificationPresent: false,
      },
      account: {
        status: request.affiliateProfile.user.status,
        ageDays: accountAgeDays,
        ageBucket: ageBucket(accountAgeDays),
        profileVerified: Boolean(request.affiliateProfile.identityVerified),
        nafathVerified: false,
        kycStatus: null,
      },
      history: await this.affiliateHistory(request.affiliateProfileId, request.id),
    };

    return {
      context,
      auditRefs: {
        requestId: request.id,
        userId: request.affiliateProfile.userId,
        entityType: 'PROFILE_CHANGE_REQUEST',
      },
    };
  }

  private async duplicateCheck(
    fieldType: ProfileSensitiveChangeFieldType,
    requestedSource: RawValueSource,
    userId: string
  ): Promise<ProfileSensitiveChangeDuplicateSignal> {
    if (fieldType === 'EMAIL') {
      const email = normalizedEmail(valueFromSource(requestedSource, ['email']));
      if (!email) return 'unavailable';
      const duplicate = await prisma.user.findFirst({
        where: { email, id: { not: userId } },
        select: { id: true },
      });
      return duplicate ? 'conflict' : 'clear';
    }

    if (fieldType === 'PHONE_NUMBER') {
      const phoneNumber = normalizedPhone(
        valueFromSource(requestedSource, ['phoneNumber', 'phone'])
      );
      if (!phoneNumber) return 'unavailable';
      const duplicate = await prisma.user.findFirst({
        where: { phoneNumber, id: { not: userId } },
        select: { id: true },
      });
      return duplicate ? 'conflict' : 'clear';
    }

    return 'unavailable';
  }

  private async providerHistory(
    providerId: string,
    requestId: string
  ): Promise<ProfileSensitiveChangeContext['history']> {
    const [pending, rejected, approved] = await Promise.all([
      prisma.profileModificationRequest.count({
        where: {
          providerId,
          id: { not: requestId },
          status: { in: PROVIDER_PENDING_STATUSES },
        },
      }),
      prisma.profileModificationRequest.count({
        where: {
          providerId,
          id: { not: requestId },
          status: ModificationStatus.REJECTED,
        },
      }),
      prisma.profileModificationRequest.count({
        where: {
          providerId,
          id: { not: requestId },
          status: { in: PROVIDER_APPROVED_STATUSES },
        },
      }),
    ]);

    return {
      priorPendingSensitiveRequestCount: pending,
      priorRejectedSensitiveRequestCount: rejected,
      priorApprovedSensitiveRequestCount: approved,
    };
  }

  private async affiliateHistory(
    affiliateProfileId: string,
    requestId: string
  ): Promise<ProfileSensitiveChangeContext['history']> {
    const [pending, rejected, approved] = await Promise.all([
      prisma.profileChangeRequest.count({
        where: {
          affiliateProfileId,
          id: { not: requestId },
          status: { in: AFFILIATE_PENDING_STATUSES },
        },
      }),
      prisma.profileChangeRequest.count({
        where: {
          affiliateProfileId,
          id: { not: requestId },
          status: ChangeRequestStatus.REJECTED,
        },
      }),
      prisma.profileChangeRequest.count({
        where: {
          affiliateProfileId,
          id: { not: requestId },
          status: { in: AFFILIATE_APPROVED_STATUSES },
        },
      }),
    ]);

    return {
      priorPendingSensitiveRequestCount: pending,
      priorRejectedSensitiveRequestCount: rejected,
      priorApprovedSensitiveRequestCount: approved,
    };
  }
}

export const profileIntelligenceContextService =
  new ProfileIntelligenceContextService();
