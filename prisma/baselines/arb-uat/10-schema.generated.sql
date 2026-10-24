-- 10-schema.generated.sql — GENERATED, do not edit by hand.
--   npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script   (prisma 7.8.0)
-- Regenerate and re-run the verification in README.md whenever schema.prisma changes before this baseline is used.
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CLIENT_COMPANY', 'CLIENT_INDIVIDUAL', 'PROVIDER_COMPANY', 'PROVIDER_INDIVIDUAL', 'MARKETING_BROKER', 'EMPLOYEE', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'SUSPENDED_REVIEW');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CLIENT', 'PROVIDER', 'AFFILIATE', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING_AI_REVIEW', 'PENDING_HUMAN_APPROVAL', 'APPROVED_AND_APPLIED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SensitiveFieldType" AS ENUM ('IBAN', 'NATIONAL_ID', 'PHONE_NUMBER', 'EMAIL', 'BANK_NAME', 'ACCOUNT_HOLDER_NAME', 'SWIFT_CODE', 'FIRST_NAME', 'LAST_NAME');

-- CreateEnum
CREATE TYPE "ModificationStatus" AS ENUM ('PENDING_OTP', 'IN_AI_REVIEW', 'PENDING_HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AIAuditResult" AS ENUM ('PASSED', 'NEEDS_HUMAN_REVIEW', 'FLAGGED');

-- CreateEnum
CREATE TYPE "KYCStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('AVAILABLE', 'BUSY', 'OFFLINE');

-- CreateEnum
CREATE TYPE "RuleType" AS ENUM ('GAIN', 'LOSS');

-- CreateEnum
CREATE TYPE "LogCategory" AS ENUM ('ROLE_ADDITION', 'PROFILE_COMPLETION', 'SECURITY_CHANGE', 'SYSTEM_AUDIT');

-- CreateEnum
CREATE TYPE "LogStatus" AS ENUM ('IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "OtpType" AS ENUM ('EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'PENDING_SIGNATURE', 'PENDING_REVIEW', 'OPEN', 'IN_PROGRESS', 'AWAITING_DELIVERY', 'PENDING_APPROVAL', 'COMPLETED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'DRAFT', 'PENDING_SIGNATURE', 'IN_AI_REVIEW', 'SUBMITTED', 'UNDER_NEGOTIATION', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('HELD', 'RELEASED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'PROCESSING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SpecialOfferType" AS ENUM ('BUNDLE', 'DIRECT_DISCOUNT');

-- CreateEnum
CREATE TYPE "ModelStatus" AS ENUM ('DRAFT', 'PENDING_SIGNATURE', 'PENDING_APPROVAL', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('DRAFT', 'PENDING_SIGNATURE', 'PENDING_APPROVAL', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SpecialtyVerificationStatus" AS ENUM ('PENDING_PROOF', 'PENDING_AUDIT', 'PENDING_TEST', 'UNDER_AI_REVIEW', 'TEST_REQUIRED', 'APPROVED', 'REJECTED', 'LOCKED_OUT');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('ALL', 'OFFERS', 'PROJECTS', 'FINANCIAL', 'AI');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'AWAITING_CUSTOMER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'FILE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('SENT', 'DELIVERED', 'READ');

-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('GENERAL', 'PROJECT');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'QUALIFIED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "SourceChannel" AS ENUM ('TIKTOK', 'X_TWITTER', 'INSTAGRAM', 'LINKEDIN', 'OTHER');

-- CreateEnum
CREATE TYPE "CommissionType" AS ENUM ('NEW_CLIENT_REQUEST', 'FIRST_PROJECT_COMPLETED', 'SUBSCRIPTION', 'STAGE_RELEASE');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('PENDING_CLIENT_SIGNATURE', 'PENDING_PAYMENT', 'PENDING_PROVIDER_SIGNATURE', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "AmendmentRequesterRole" AS ENUM ('CLIENT', 'PROVIDER');

-- CreateEnum
CREATE TYPE "AmendmentType" AS ENUM ('SCOPE', 'BUDGET', 'DURATION', 'MIXED');

-- CreateEnum
CREATE TYPE "AmendmentStatus" AS ENUM ('PENDING_OTHER_PARTY', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProjectStageStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUBMITTED', 'REVISION_REQUESTED', 'APPROVED');

-- CreateEnum
CREATE TYPE "StageDeliveryStatus" AS ENUM ('SUBMITTED', 'REVISION_REQUESTED', 'APPROVED');

-- CreateEnum
CREATE TYPE "ProofFileType" AS ENUM ('PROOF_DOCUMENT', 'WORK_SAMPLE');

-- CreateEnum
CREATE TYPE "AccreditationStatus" AS ENUM ('PENDING_AI_AUDIT', 'AI_VERIFIED', 'REJECTED', 'MANUAL_REVIEW', 'NEEDS_COMPLETION');

-- CreateEnum
CREATE TYPE "ProofUploadStatus" AS ENUM ('UPLOADING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('IN_PROGRESS', 'STREAMING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BudgetType" AS ENUM ('FIXED', 'RANGE', 'HOURLY');

-- CreateEnum
CREATE TYPE "ProviderTypePreference" AS ENUM ('INDIVIDUAL', 'COMPANY', 'ACCREDITED_ONLY', 'ANY');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('DRAFT', 'PENDING_SIGNATURE', 'OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'PROCESSING', 'REJECTED', 'COMPLETED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PayoutAttemptStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PaypalWebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaypalPaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ArbPaymentStatus" AS ENUM ('CREATED', 'CREATE_UNKNOWN', 'CREATE_REJECTED', 'REDIRECTED', 'VERIFYING', 'UNCONFIRMED', 'CANCELLED', 'EXPIRED', 'AUTH_ONLY', 'DECLINED', 'CAPTURED_APPLIED');

-- CreateEnum
CREATE TYPE "TeamMemberType" AS ENUM ('PROVIDER', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "TeamMemberStatus" AS ENUM ('ACTIVE', 'PENDING', 'INACTIVE');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "accountType" "AccountType" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "roles" "UserRole"[] DEFAULT ARRAY['CLIENT']::"UserRole"[],
    "activeRole" "UserRole" NOT NULL DEFAULT 'CLIENT',
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phoneCountryCode" TEXT DEFAULT '+966',
    "phoneNumber" TEXT,
    "phoneOtpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "password" TEXT,
    "avatarUrl" TEXT,
    "authProvider" TEXT NOT NULL DEFAULT 'local',
    "googleId" TEXT,
    "agreedToTerms" BOOLEAN NOT NULL DEFAULT false,
    "profileCompletionPercent" INTEGER NOT NULL DEFAULT 0,
    "currentLevel" TEXT NOT NULL DEFAULT 'مستكشف - المستوى 1',
    "pointsToNextLevel" INTEGER NOT NULL DEFAULT 100,
    "currentPoints" INTEGER NOT NULL DEFAULT 0,
    "idNumber" TEXT,
    "idExpiryDate" TIMESTAMP(3),
    "idDocumentUrl" TEXT,
    "commercialRegistration" TEXT,
    "vatCertificateUrl" TEXT,
    "alternativePhone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "region" TEXT,
    "ibanNumber" TEXT,
    "bankName" TEXT,
    "accountHolderName" TEXT,
    "lastActiveAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "walletBalance" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "totalGmvAmount" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "completedProjectsCount" INTEGER NOT NULL DEFAULT 0,
    "ratingAverage" DOUBLE PRECISION DEFAULT 0.0,
    "tierLevel" TEXT DEFAULT 'Bronze',
    "aiRiskScore" INTEGER NOT NULL DEFAULT 10,
    "aiRiskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "aiSuspiciousNotes" TEXT,
    "marketingMonthlySpendCap" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "device" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_change_requests" (
    "id" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "affiliateProfileId" TEXT NOT NULL,
    "fieldType" "SensitiveFieldType" NOT NULL,
    "fieldLabel" TEXT NOT NULL,
    "currentValue" TEXT,
    "requestedValue" TEXT NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING_AI_REVIEW',
    "aiRecommendation" TEXT,
    "aiConfidenceScore" INTEGER,
    "rejectionReason" TEXT,
    "reviewedBy" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_modification_requests" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "fieldLabel" TEXT NOT NULL,
    "currentValue" TEXT,
    "requestedValue" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'PROFILE',
    "requiresOtp" BOOLEAN NOT NULL DEFAULT false,
    "otpVerifiedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "status" "ModificationStatus" NOT NULL DEFAULT 'IN_AI_REVIEW',
    "aiConfidence" DOUBLE PRECISION,
    "aiRecommendation" TEXT,
    "aiAuditStatus" "AIAuditResult",
    "reviewedByAdmin" BOOLEAN NOT NULL DEFAULT false,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_modification_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" TEXT,
    "crNumber" TEXT,
    "companySize" TEXT,
    "website" TEXT,
    "bio" TEXT,
    "interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "portfolioUrl" TEXT,
    "linkedinUrl" TEXT,
    "personalWebsiteUrl" TEXT,
    "interfaceLanguage" TEXT,
    "timezone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "avatarUrl" TEXT,
    "currentLevel" TEXT DEFAULT 'مستكشف - المستوى 1',
    "currentPoints" INTEGER NOT NULL DEFAULT 0,
    "pointsToNextLevel" INTEGER DEFAULT 100,
    "completionPercentage" INTEGER NOT NULL DEFAULT 0,
    "idNumber" TEXT,
    "dob" TIMESTAMP(3),
    "country" TEXT DEFAULT 'السعودية',
    "city" TEXT,
    "industry" TEXT,
    "address" TEXT,
    "isNafathVerified" BOOLEAN NOT NULL DEFAULT false,
    "frontIdUrl" TEXT,
    "backIdUrl" TEXT,
    "kycStatus" "KYCStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "paymentType" TEXT,
    "bankName" TEXT,
    "accountHolder" TEXT,
    "iban" TEXT,
    "paypalPayoutEmail" TEXT,
    "supportingDocsUrl" TEXT,
    "notes" TEXT,
    "accurateAgreed" BOOLEAN NOT NULL DEFAULT false,
    "termsAgreed" BOOLEAN NOT NULL DEFAULT false,
    "privacyAgreed" BOOLEAN NOT NULL DEFAULT false,
    "isProfileComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" TEXT,
    "headline" TEXT,
    "bio" TEXT,
    "hourlyRate" DOUBLE PRECISION,
    "yearsOfExperience" INTEGER,
    "location" TEXT,
    "city" TEXT,
    "country" TEXT,
    "availabilityStatus" "AvailabilityStatus" NOT NULL DEFAULT 'AVAILABLE',
    "completionPercentage" INTEGER NOT NULL DEFAULT 0,
    "githubUrl" TEXT,
    "linkedinUrl" TEXT,
    "twitterUrl" TEXT,
    "websiteUrl" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferences" JSONB,
    "mainSpecialty" TEXT,
    "subSpecialties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstName" TEXT,
    "lastName" TEXT,
    "avatarUrl" TEXT,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "idNumber" TEXT,
    "dob" TIMESTAMP(3),
    "industry" TEXT,
    "address" TEXT,
    "isNafathVerified" BOOLEAN NOT NULL DEFAULT false,
    "frontIdUrl" TEXT,
    "backIdUrl" TEXT,
    "certUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kycStatus" "KYCStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "paymentType" TEXT,
    "bankName" TEXT,
    "accountHolder" TEXT,
    "iban" TEXT,
    "paypalPayoutEmail" TEXT,
    "supportingDocsUrl" TEXT,
    "notes" TEXT,
    "accurateAgreed" BOOLEAN NOT NULL DEFAULT false,
    "termsAgreed" BOOLEAN NOT NULL DEFAULT false,
    "privacyAgreed" BOOLEAN NOT NULL DEFAULT false,
    "isProfileSetupComplete" BOOLEAN NOT NULL DEFAULT false,
    "setupTestScore" DOUBLE PRECISION,
    "setupTestStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "setupTestBannedUntil" TIMESTAMP(3),
    "setupTestCheatAttempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "provider_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_items" (
    "id" TEXT NOT NULL,
    "providerProfileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "coverImage" TEXT,
    "projectUrl" TEXT,
    "completionDate" TIMESTAMP(3),
    "tags" TEXT[],

    CONSTRAINT "portfolio_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "educations" (
    "id" TEXT NOT NULL,
    "providerProfileId" TEXT NOT NULL,
    "degree" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "description" TEXT,

    CONSTRAINT "educations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_gamification" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "completedProjects" INTEGER NOT NULL DEFAULT 0,
    "avgRating" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "currentLevelIndex" INTEGER NOT NULL DEFAULT 1,
    "currentCommission" DOUBLE PRECISION NOT NULL DEFAULT 15.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_gamification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "clientId" TEXT,
    "projectId" TEXT,
    "serviceId" TEXT,
    "clientRequestId" TEXT,
    "stageId" TEXT,
    "reviewerRole" TEXT NOT NULL DEFAULT 'CLIENT',
    "rating" DOUBLE PRECISION NOT NULL,
    "comment" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_transactions" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gamification_rules" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "RuleType" NOT NULL,
    "label" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "description" TEXT,

    CONSTRAINT "gamification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "LogCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "actionText" TEXT NOT NULL,
    "status" "LogStatus" NOT NULL DEFAULT 'IN_REVIEW',
    "statusText" TEXT,
    "canResubmit" BOOLEAN NOT NULL DEFAULT false,
    "metaData" JSONB,
    "eventType" TEXT,
    "source" TEXT,
    "severity" TEXT DEFAULT 'INFO',
    "summary" TEXT,
    "beforeData" JSONB,
    "afterData" JSONB,
    "context" JSONB,
    "requestId" TEXT,
    "sessionId" TEXT,
    "ipAddress" TEXT,
    "device" TEXT,
    "actorLabel" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" TEXT NOT NULL,
    "providerProfileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3),
    "credentialUrl" TEXT,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "OtpType" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "context" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "subSpecialties" TEXT[],
    "ndaType" TEXT NOT NULL DEFAULT 'standard',
    "ipRights" TEXT NOT NULL DEFAULT 'client',
    "provLevel" TEXT,
    "provRating" DOUBLE PRECISION,
    "provLang" TEXT,
    "provLocation" TEXT,
    "customConditions" TEXT,
    "requirements" TEXT[],
    "outputs" TEXT,
    "deliveryDays" INTEGER NOT NULL,
    "budgetType" TEXT NOT NULL DEFAULT 'range',
    "budgetMin" DOUBLE PRECISION,
    "budgetMax" DOUBLE PRECISION,
    "budgetFixed" DOUBLE PRECISION,
    "budgetHourly" DOUBLE PRECISION,
    "allowNegotiation" BOOLEAN NOT NULL DEFAULT true,
    "splitMilestones" BOOLEAN NOT NULL DEFAULT false,
    "milestones" JSONB,
    "attachments" TEXT[],
    "proposalsCount" INTEGER NOT NULL DEFAULT 0,
    "status" "ProjectStatus" NOT NULL DEFAULT 'OPEN',
    "clientId" TEXT NOT NULL,
    "providerId" TEXT,
    "serviceCatalogId" TEXT,
    "assignedEmployeeId" TEXT,
    "aiAnalysis" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_projects" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposals" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "clientRequestId" TEXT,
    "providerId" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "deliveryDays" INTEGER NOT NULL,
    "aiMatchScore" DOUBLE PRECISION,
    "status" "ProposalStatus" NOT NULL,
    "coverLetter" TEXT,
    "workPlan" TEXT,
    "aiFairPriceMin" DOUBLE PRECISION,
    "aiFairPriceMax" DOUBLE PRECISION,
    "aiPriceTag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalAttachment" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,

    CONSTRAINT "ProposalAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrows" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "EscrowStatus" NOT NULL,
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "fundedAt" TIMESTAMP(3),
    "releasedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "feePolicyVersion" INTEGER,
    "providerCommissionRateSnapshot" DOUBLE PRECISION,
    "providerCommissionLevelSnapshot" INTEGER,
    "providerCommissionSnapshotAt" TIMESTAMP(3),
    "platformCommissionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "providerNetReleasedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escrows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_catalogs" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "specialtyId" TEXT,
    "subSpecialty" TEXT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "portfolioItemId" TEXT,
    "accreditationSampleId" TEXT,
    "gallery" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "totalDays" INTEGER NOT NULL,
    "status" "ModelStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "aiScore" INTEGER,
    "aiClarityScore" INTEGER,
    "aiFeasibilityScore" INTEGER,
    "aiReviewSummary" TEXT,
    "aiReviewDetails" JSONB,
    "approvedAt" TIMESTAMP(3),
    "aiAuditScore" DOUBLE PRECISION,
    "aiAuditFeedback" JSONB,
    "aiAuditReport" JSONB,
    "auditRejectionReason" TEXT,
    "viewsCount" INTEGER NOT NULL DEFAULT 0,
    "salesCount" INTEGER NOT NULL DEFAULT 0,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "discountPercentage" INTEGER,
    "offerEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_catalogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL DEFAULT 'basic',
    "packageName" TEXT NOT NULL DEFAULT 'الباقة الأساسية',
    "savedForLater" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "providerId" TEXT,
    "code" TEXT NOT NULL,
    "discountType" TEXT NOT NULL DEFAULT 'percentage',
    "discountValue" DOUBLE PRECISION NOT NULL,
    "minimumAmount" DOUBLE PRECISION,
    "maxDiscount" DOUBLE PRECISION,
    "maxUsesPerUser" INTEGER NOT NULL DEFAULT 1,
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "excludedServiceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "internalNote" TEXT,
    "assignedToTeamMemberId" TEXT,
    "createdByTeamMemberId" TEXT,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NONE',
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_services" (
    "couponId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,

    CONSTRAINT "coupon_services_pkey" PRIMARY KEY ("couponId","serviceId")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "subtotal" DOUBLE PRECISION NOT NULL,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL,
    "couponId" TEXT,
    "couponCode" TEXT,
    "couponDiscountType" TEXT,
    "couponDiscountValue" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_redemptions" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "special_offers" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "type" "SpecialOfferType" NOT NULL,
    "name" TEXT NOT NULL,
    "primaryServiceId" TEXT,
    "beneficiaryServiceId" TEXT,
    "targetServiceId" TEXT,
    "discountValue" DOUBLE PRECISION NOT NULL,
    "validityDays" INTEGER,
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "badgeText" TEXT NOT NULL,
    "customerMessage" TEXT,
    "internalNote" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "assignedToTeamMemberId" TEXT,
    "createdByTeamMemberId" TEXT,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NONE',
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "special_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "special_offer_redemptions" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "special_offer_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "serviceId" TEXT,
    "modelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL,
    "packageId" TEXT NOT NULL DEFAULT 'basic',
    "packageName" TEXT NOT NULL DEFAULT 'الباقة الأساسية',
    "price" DOUBLE PRECISION NOT NULL,
    "deliveryDays" INTEGER NOT NULL,
    "aiScore" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_favorites" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_stages" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "deliveryDays" INTEGER NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL,
    "computedAmount" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "service_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "icon" TEXT,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialties" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "icon" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "specialties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_specialties" (
    "id" TEXT NOT NULL,
    "providerProfileId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,
    "hasTakenAssessment" BOOLEAN NOT NULL DEFAULT false,
    "latestScore" DOUBLE PRECISION,
    "isPassed" BOOLEAN NOT NULL DEFAULT false,
    "passedAt" TIMESTAMP(3),
    "subSpecialties" TEXT[],
    "status" "SpecialtyVerificationStatus" NOT NULL DEFAULT 'PENDING_PROOF',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "aiScore" DOUBLE PRECISION,
    "feasibilityScore" DOUBLE PRECISION,
    "clarityScore" DOUBLE PRECISION,
    "ownershipCredibility" DOUBLE PRECISION,
    "quizScore" DOUBLE PRECISION,
    "badgeGrantedAt" TIMESTAMP(3),
    "lockoutUntil" TIMESTAMP(3),
    "aiFeedback" JSONB,
    "legalSignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_specialties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,
    "subSpecialtyTag" TEXT,
    "text" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correctOptionIndex" INTEGER NOT NULL,
    "explanation" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_samples" (
    "id" TEXT NOT NULL,
    "providerSpecialtyId" TEXT NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "technologies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "publicSampleUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "fileBytes" INTEGER NOT NULL DEFAULT 0,
    "watermarkLabel" VARCHAR(50) NOT NULL DEFAULT 'وسيط AI',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proof_attachments" (
    "id" TEXT NOT NULL,
    "workSampleId" TEXT NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "fileBytes" INTEGER NOT NULL DEFAULT 0,
    "isConfidential" BOOLEAN NOT NULL DEFAULT true,
    "watermarkLabel" VARCHAR(50) NOT NULL DEFAULT 'وسيط AI',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proof_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_audit_logs" (
    "id" TEXT NOT NULL,
    "providerSpecialtyId" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "rawRequest" JSONB NOT NULL,
    "rawResponse" JSONB NOT NULL,
    "evaluationResult" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_proposals" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "title" VARCHAR(80) NOT NULL,
    "message" TEXT NOT NULL,
    "advantages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outputs" TEXT,
    "portfolioIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "totalPrice" DOUBLE PRECISION NOT NULL,
    "deliveryDays" INTEGER NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "aiMatchScore" DOUBLE PRECISION,
    "aiQualityTag" TEXT,
    "aiPriceTag" TEXT,
    "aiFeedback" JSONB,
    "agreedToTerms" BOOLEAN NOT NULL DEFAULT false,
    "agreedToEscrow" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_milestones" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "proposal_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'GENERAL',
    "category" "NotificationCategory" NOT NULL DEFAULT 'ALL',
    "actionUrl" TEXT,
    "actionText" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "ticketNumber" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'عادية',
    "description" TEXT NOT NULL,
    "relatedOrder" TEXT,
    "relatedProject" TEXT,
    "relatedMember" TEXT,
    "ccEmail" TEXT,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "offer_id" TEXT,
    "client_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "kind" "ConversationKind" NOT NULL DEFAULT 'GENERAL',
    "contract_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'SENT',
    "file_url" TEXT,
    "file_name" TEXT,
    "file_size" INTEGER,
    "audio_duration" INTEGER,
    "context" JSONB,
    "event_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "referralSlug" TEXT,
    "currentLevel" TEXT NOT NULL DEFAULT 'مساعد',
    "commissionRatePercentage" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "notifyOnNewReferral" BOOLEAN NOT NULL DEFAULT true,
    "sharePerformanceStats" BOOLEAN NOT NULL DEFAULT false,
    "firstName" TEXT,
    "lastName" TEXT,
    "avatarUrl" TEXT,
    "bio" TEXT,
    "bankName" TEXT,
    "accountHolderName" TEXT,
    "iban" TEXT,
    "swiftCode" TEXT,
    "paypalPayoutEmail" TEXT,
    "identityVerified" BOOLEAN NOT NULL DEFAULT false,
    "kycDocumentUrl" TEXT,
    "kycRejectionReason" TEXT,
    "kycReviewedAt" TIMESTAMP(3),
    "payoutMethod" TEXT DEFAULT 'BANK_TRANSFER',
    "minimumPayoutAmount" DOUBLE PRECISION NOT NULL DEFAULT 300.0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "completionPercentage" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_channel_handles" (
    "id" TEXT NOT NULL,
    "affiliateProfileId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_channel_handles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "sourceChannel" "SourceChannel" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_logs" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "referralId" TEXT,
    "referredUserId" TEXT NOT NULL,
    "sourceProjectId" TEXT,
    "sourceStageId" TEXT,
    "baseAmount" DOUBLE PRECISION NOT NULL,
    "appliedPercentage" DOUBLE PRECISION NOT NULL,
    "level" INTEGER NOT NULL,
    "type" "CommissionType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_channel_metrics" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "channel" "SourceChannel" NOT NULL,
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "clients" INTEGER NOT NULL DEFAULT 0,
    "conversionPercentage" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_channel_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_custom_links" (
    "id" TEXT NOT NULL,
    "affiliateId" TEXT NOT NULL,
    "channelName" TEXT NOT NULL,
    "utmSource" TEXT NOT NULL,
    "customSlug" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_custom_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_skill_assessments" (
    "id" TEXT NOT NULL,
    "providerProfileId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_skill_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "offerId" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "phasesCount" INTEGER NOT NULL DEFAULT 1,
    "terms" JSONB,
    "status" "ContractStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "clientSignedAt" TIMESTAMP(3),
    "providerSignedAt" TIMESTAMP(3),
    "clientSignatureHash" TEXT,
    "providerSignatureHash" TEXT,
    "termsVersion" INTEGER NOT NULL DEFAULT 1,
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_amendments" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedByRole" "AmendmentRequesterRole" NOT NULL,
    "type" "AmendmentType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "budgetDelta" DOUBLE PRECISION,
    "durationDeltaDays" INTEGER,
    "status" "AmendmentStatus" NOT NULL DEFAULT 'PENDING_OTHER_PARTY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "priceBefore" DOUBLE PRECISION,
    "priceAfter" DOUBLE PRECISION,
    "durationBefore" INTEGER,
    "durationAfter" INTEGER,
    "addedStageId" TEXT,
    "fundingAuthorizedAt" TIMESTAMP(3),
    "fundingAuthorizedAmount" DOUBLE PRECISION,
    "fundingAuthorizedTerms" TEXT,

    CONSTRAINT "project_amendments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_terms_versions" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "addendumText" TEXT NOT NULL,
    "amendmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_terms_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_stages" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "days" INTEGER NOT NULL,
    "percentage" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "ProjectStageStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "amendmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_deliveries" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "files" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "StageDeliveryStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewNote" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stage_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accreditation_samples" (
    "id" TEXT NOT NULL,
    "providerProfileId" TEXT NOT NULL,
    "providerSpecialtyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "projectUrl" TEXT,
    "githubUrl" TEXT,
    "technologiesUsed" TEXT[],
    "attachments" TEXT[],
    "status" "AccreditationStatus" NOT NULL DEFAULT 'PENDING_AI_AUDIT',
    "aiScore" DOUBLE PRECISION,
    "aiQualityRating" TEXT,
    "aiFeedbackAr" TEXT,
    "aiStrengths" TEXT[],
    "aiRecommendations" TEXT[],
    "aiAuditedAt" TIMESTAMP(3),
    "viewsCount" INTEGER NOT NULL DEFAULT 0,
    "rating" DOUBLE PRECISION DEFAULT 0.0,
    "reviewsCount" INTEGER NOT NULL DEFAULT 0,
    "offersGenerated" INTEGER NOT NULL DEFAULT 0,
    "offersAccepted" INTEGER NOT NULL DEFAULT 0,
    "userNote" TEXT,
    "internalNote" TEXT,
    "completionFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 1,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accreditation_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_accreditation_submissions" (
    "id" TEXT NOT NULL,
    "providerProfileId" TEXT NOT NULL,
    "providerSpecialtyId" TEXT NOT NULL,
    "status" "AccreditationStatus" NOT NULL DEFAULT 'PENDING_AI_AUDIT',
    "overallAiScore" DOUBLE PRECISION,
    "aiDecisionSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_accreditation_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_accreditation_proofs" (
    "id" TEXT NOT NULL,
    "accreditationSubmissionId" TEXT NOT NULL,
    "fileType" "ProofFileType" NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER,
    "aiAuthenticityScore" DOUBLE PRECISION,
    "aiDetectedQualityScore" DOUBLE PRECISION,
    "aiTechnicalAnalysis" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_accreditation_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_accreditation_audit_logs" (
    "id" TEXT NOT NULL,
    "accreditationSubmissionId" TEXT NOT NULL,
    "promptTokensUsed" INTEGER,
    "completionTokensUsed" INTEGER,
    "rawAiResponse" JSONB NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_accreditation_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_attempts" (
    "id" TEXT NOT NULL,
    "providerSpecialtyId" TEXT NOT NULL,
    "providerProfileId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,
    "subSpecialtiesSnapshot" JSONB,
    "analyzedAssetsSnapshot" JSONB,
    "questionsPayload" JSONB NOT NULL,
    "submittedAnswers" JSONB,
    "totalQuestions" INTEGER NOT NULL DEFAULT 20,
    "score" DOUBLE PRECISION,
    "isPassed" BOOLEAN NOT NULL DEFAULT false,
    "feedbackAr" TEXT,
    "strengths" TEXT[],
    "weaknesses" TEXT[],
    "status" "AssessmentStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "timeLimitMinutes" INTEGER NOT NULL DEFAULT 15,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "projectId" TEXT,
    "openedById" TEXT NOT NULL,
    "againstUserId" TEXT,
    "resolvedById" TEXT,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resolution" TEXT,
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "method" TEXT NOT NULL,
    "accountName" TEXT,
    "accountNumber" TEXT,
    "iban" TEXT,
    "paypalEmail" TEXT,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "rejectionReason" TEXT,
    "adminNote" TEXT,
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_attempts" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "senderBatchId" TEXT NOT NULL,
    "payoutBatchId" TEXT,
    "payoutItemId" TEXT,
    "status" "PayoutAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "paypalTerminalStatus" TEXT,
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "payout_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paypal_webhook_events" (
    "id" TEXT NOT NULL,
    "paypalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "resourceType" TEXT,
    "paypalCreateTime" TIMESTAMP(3),
    "payoutAttemptId" TEXT,
    "status" "PaypalWebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "rawEvent" JSONB,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paypal_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_onboarding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentUrl" TEXT NOT NULL,
    "documentName" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_onboarding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_requests" (
    "id" TEXT NOT NULL,
    "clientProfileId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "subSpecialties" TEXT[],
    "requiredSkills" TEXT[],
    "budgetType" "BudgetType" NOT NULL DEFAULT 'FIXED',
    "minBudget" DOUBLE PRECISION,
    "maxBudget" DOUBLE PRECISION,
    "expectedDurationDays" INTEGER,
    "preferredProviderType" "ProviderTypePreference" NOT NULL DEFAULT 'ANY',
    "requiresNda" BOOLEAN NOT NULL DEFAULT false,
    "attachments" TEXT[],
    "outputs" TEXT,
    "customConditions" TEXT,
    "ipRights" TEXT NOT NULL DEFAULT 'client',
    "providerPreferences" JSONB,
    "allowNegotiation" BOOLEAN NOT NULL DEFAULT true,
    "splitMilestones" BOOLEAN NOT NULL DEFAULT false,
    "milestones" JSONB,
    "aiAnalyzedSummary" TEXT,
    "aiComplexityRating" TEXT,
    "status" "RequestStatus" NOT NULL DEFAULT 'OPEN',
    "proposalsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "paymentMethod" TEXT,
    "referenceId" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paypal_payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "paypalOrderId" TEXT NOT NULL,
    "paypalCaptureId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "netAmount" DECIMAL(12,2),
    "feeAmount" DECIMAL(12,2),
    "feePercent" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "PaypalPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paypal_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arb_payments" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "status" "ArbPaymentStatus" NOT NULL DEFAULT 'CREATED',
    "netUsd" DECIMAL(12,2) NOT NULL,
    "feeUsd" DECIMAL(12,2) NOT NULL,
    "feePercent" DOUBLE PRECISION NOT NULL,
    "grossUsd" DECIMAL(12,2) NOT NULL,
    "fxSarPerUsd" DECIMAL(12,6) NOT NULL,
    "amountSar" DECIMAL(12,2) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT '682',
    "bankPaymentId" TEXT,
    "bankTransId" TEXT,
    "bankRef" TEXT,
    "bankResult" TEXT,
    "bankAuthCode" TEXT,
    "bankCardType" TEXT,
    "paymentPageUrl" TEXT,
    "customerIp" TEXT,
    "inquiryCount" INTEGER NOT NULL DEFAULT 0,
    "lastInquiryAt" TIMESTAMP(3),
    "bankFinalAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "walletTxId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "arb_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_subscribers" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unsubscribedAt" TIMESTAMP(3),
    "source" TEXT,

    CONSTRAINT "newsletter_subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_team_members" (
    "id" TEXT NOT NULL,
    "companyOwnerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "jobTitle" TEXT NOT NULL,
    "memberType" "TeamMemberType" NOT NULL,
    "status" "TeamMemberStatus" NOT NULL DEFAULT 'PENDING',
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "marketing_assets" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "fileUrl" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "fileBytes" INTEGER,
    "linkUrl" TEXT,
    "text" TEXT,
    "audience" TEXT NOT NULL DEFAULT 'MARKETER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_counters" (
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL,
    "reset_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "accreditation_sample_events" (
    "id" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "userNote" TEXT,
    "internalNote" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accreditation_sample_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accreditation_proof_uploads" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerSpecialtyId" TEXT NOT NULL,
    "sampleId" TEXT,
    "kind" "ProofFileType" NOT NULL DEFAULT 'WORK_SAMPLE',
    "privateRef" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "status" "ProofUploadStatus" NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accreditation_proof_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_digest_state" (
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "last_digest_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_digest_state_pkey" PRIMARY KEY ("user_id","conversation_id")
);

-- CreateTable
CREATE TABLE "chat_digest_activation" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_digest_activation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ProviderProfileToSkill" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ProviderProfileToSkill_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phoneNumber_key" ON "users"("phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");

-- CreateIndex
CREATE INDEX "users_accountType_status_idx" ON "users"("accountType", "status");

-- CreateIndex
CREATE INDEX "users_aiRiskScore_idx" ON "users"("aiRiskScore");

-- CreateIndex
CREATE INDEX "users_lastActiveAt_idx" ON "users"("lastActiveAt");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_tokenHash_key" ON "user_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "user_sessions_userId_revokedAt_lastActiveAt_idx" ON "user_sessions"("userId", "revokedAt", "lastActiveAt");

-- CreateIndex
CREATE INDEX "user_sessions_expiresAt_idx" ON "user_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "profile_change_requests_requestNumber_key" ON "profile_change_requests"("requestNumber");

-- CreateIndex
CREATE INDEX "profile_modification_requests_providerId_idx" ON "profile_modification_requests"("providerId");

-- CreateIndex
CREATE INDEX "profile_modification_requests_status_idx" ON "profile_modification_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "client_profiles_userId_key" ON "client_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_profiles_userId_key" ON "provider_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "skills_name_key" ON "skills"("name");

-- CreateIndex
CREATE INDEX "portfolio_items_providerProfileId_idx" ON "portfolio_items"("providerProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_gamification_providerId_key" ON "provider_gamification"("providerId");

-- CreateIndex
CREATE INDEX "reviews_providerId_idx" ON "reviews"("providerId");

-- CreateIndex
CREATE INDEX "reviews_serviceId_idx" ON "reviews"("serviceId");

-- CreateIndex
CREATE INDEX "reviews_projectId_idx" ON "reviews"("projectId");

-- CreateIndex
CREATE INDEX "reviews_clientRequestId_idx" ON "reviews"("clientRequestId");

-- CreateIndex
CREATE INDEX "reviews_stageId_idx" ON "reviews"("stageId");

-- CreateIndex
CREATE INDEX "point_transactions_providerId_idx" ON "point_transactions"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "gamification_rules_code_key" ON "gamification_rules"("code");

-- CreateIndex
CREATE INDEX "account_audit_logs_userId_idx" ON "account_audit_logs"("userId");

-- CreateIndex
CREATE INDEX "account_audit_logs_category_idx" ON "account_audit_logs"("category");

-- CreateIndex
CREATE INDEX "account_audit_logs_status_idx" ON "account_audit_logs"("status");

-- CreateIndex
CREATE INDEX "account_audit_logs_userId_occurredAt_idx" ON "account_audit_logs"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "account_audit_logs_eventType_idx" ON "account_audit_logs"("eventType");

-- CreateIndex
CREATE INDEX "account_audit_logs_source_idx" ON "account_audit_logs"("source");

-- CreateIndex
CREATE INDEX "account_audit_logs_requestId_idx" ON "account_audit_logs"("requestId");

-- CreateIndex
CREATE INDEX "account_audit_logs_sessionId_idx" ON "account_audit_logs"("sessionId");

-- CreateIndex
CREATE INDEX "projects_providerId_status_idx" ON "projects"("providerId", "status");

-- CreateIndex
CREATE INDEX "projects_serviceCatalogId_idx" ON "projects"("serviceCatalogId");

-- CreateIndex
CREATE INDEX "projects_clientId_status_idx" ON "projects"("clientId", "status");

-- CreateIndex
CREATE INDEX "projects_status_createdAt_idx" ON "projects"("status", "createdAt");

-- CreateIndex
CREATE INDEX "projects_assignedEmployeeId_idx" ON "projects"("assignedEmployeeId");

-- CreateIndex
CREATE UNIQUE INDEX "saved_projects_providerId_projectId_key" ON "saved_projects"("providerId", "projectId");

-- CreateIndex
CREATE INDEX "proposals_providerId_status_createdAt_idx" ON "proposals"("providerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "proposals_projectId_status_idx" ON "proposals"("projectId", "status");

-- CreateIndex
CREATE INDEX "proposals_clientRequestId_status_idx" ON "proposals"("clientRequestId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "escrows_projectId_key" ON "escrows"("projectId");

-- CreateIndex
CREATE INDEX "service_catalogs_providerId_idx" ON "service_catalogs"("providerId");

-- CreateIndex
CREATE INDEX "service_catalogs_status_idx" ON "service_catalogs"("status");

-- CreateIndex
CREATE INDEX "service_catalogs_specialtyId_idx" ON "service_catalogs"("specialtyId");

-- CreateIndex
CREATE INDEX "service_catalogs_accreditationSampleId_idx" ON "service_catalogs"("accreditationSampleId");

-- CreateIndex
CREATE UNIQUE INDEX "carts_userId_key" ON "carts"("userId");

-- CreateIndex
CREATE INDEX "cart_items_serviceId_idx" ON "cart_items"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_cartId_serviceId_key" ON "cart_items"("cartId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "coupons_assignedToTeamMemberId_idx" ON "coupons"("assignedToTeamMemberId");

-- CreateIndex
CREATE INDEX "coupons_createdByTeamMemberId_idx" ON "coupons"("createdByTeamMemberId");

-- CreateIndex
CREATE INDEX "coupons_providerId_approvalStatus_idx" ON "coupons"("providerId", "approvalStatus");

-- CreateIndex
CREATE INDEX "coupon_services_serviceId_idx" ON "coupon_services"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderNumber_key" ON "orders"("orderNumber");

-- CreateIndex
CREATE INDEX "orders_userId_createdAt_idx" ON "orders"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemptions_orderId_key" ON "coupon_redemptions"("orderId");

-- CreateIndex
CREATE INDEX "coupon_redemptions_couponId_userId_idx" ON "coupon_redemptions"("couponId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_redemptions_couponId_userId_orderId_key" ON "coupon_redemptions"("couponId", "userId", "orderId");

-- CreateIndex
CREATE INDEX "special_offers_providerId_approvalStatus_idx" ON "special_offers"("providerId", "approvalStatus");

-- CreateIndex
CREATE INDEX "special_offers_primaryServiceId_idx" ON "special_offers"("primaryServiceId");

-- CreateIndex
CREATE INDEX "special_offers_beneficiaryServiceId_idx" ON "special_offers"("beneficiaryServiceId");

-- CreateIndex
CREATE INDEX "special_offers_targetServiceId_idx" ON "special_offers"("targetServiceId");

-- CreateIndex
CREATE INDEX "special_offers_assignedToTeamMemberId_idx" ON "special_offers"("assignedToTeamMemberId");

-- CreateIndex
CREATE INDEX "special_offers_createdByTeamMemberId_idx" ON "special_offers"("createdByTeamMemberId");

-- CreateIndex
CREATE INDEX "special_offer_redemptions_offerId_userId_idx" ON "special_offer_redemptions"("offerId", "userId");

-- CreateIndex
CREATE INDEX "special_offer_redemptions_orderId_idx" ON "special_offer_redemptions"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "special_offer_redemptions_offerId_userId_orderId_key" ON "special_offer_redemptions"("offerId", "userId", "orderId");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_modelId_idx" ON "order_items"("modelId");

-- CreateIndex
CREATE INDEX "marketplace_favorites_serviceId_idx" ON "marketplace_favorites"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_favorites_userId_serviceId_key" ON "marketplace_favorites"("userId", "serviceId");

-- CreateIndex
CREATE INDEX "service_stages_serviceId_idx" ON "service_stages"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "specialties_slug_key" ON "specialties"("slug");

-- CreateIndex
CREATE INDEX "specialties_categoryId_idx" ON "specialties"("categoryId");

-- CreateIndex
CREATE INDEX "provider_specialties_providerProfileId_status_idx" ON "provider_specialties"("providerProfileId", "status");

-- CreateIndex
CREATE INDEX "provider_specialties_specialtyId_idx" ON "provider_specialties"("specialtyId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_specialties_providerProfileId_specialtyId_key" ON "provider_specialties"("providerProfileId", "specialtyId");

-- CreateIndex
CREATE INDEX "questions_specialtyId_isActive_idx" ON "questions"("specialtyId", "isActive");

-- CreateIndex
CREATE INDEX "work_samples_providerSpecialtyId_idx" ON "work_samples"("providerSpecialtyId");

-- CreateIndex
CREATE INDEX "proof_attachments_workSampleId_idx" ON "proof_attachments"("workSampleId");

-- CreateIndex
CREATE INDEX "ai_audit_logs_providerSpecialtyId_createdAt_idx" ON "ai_audit_logs"("providerSpecialtyId", "createdAt");

-- CreateIndex
CREATE INDEX "project_proposals_projectId_status_idx" ON "project_proposals"("projectId", "status");

-- CreateIndex
CREATE INDEX "project_proposals_providerId_idx" ON "project_proposals"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "project_proposals_projectId_providerId_key" ON "project_proposals"("projectId", "providerId");

-- CreateIndex
CREATE INDEX "proposal_milestones_proposalId_idx" ON "proposal_milestones"("proposalId");

-- CreateIndex
CREATE INDEX "notifications_userId_isRead_idx" ON "notifications"("userId", "isRead");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_key" ON "notification_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_ticketNumber_key" ON "support_tickets"("ticketNumber");

-- CreateIndex
CREATE INDEX "support_tickets_userId_status_idx" ON "support_tickets"("userId", "status");

-- CreateIndex
CREATE INDEX "support_ticket_messages_ticketId_createdAt_idx" ON "support_ticket_messages"("ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_contract_id_key" ON "conversations"("contract_id");

-- CreateIndex
CREATE INDEX "conversations_client_id_kind_idx" ON "conversations"("client_id", "kind");

-- CreateIndex
CREATE INDEX "conversations_provider_id_kind_idx" ON "conversations"("provider_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_project_id_provider_id_key" ON "conversations"("project_id", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_event_key_key" ON "messages"("event_key");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_id_idx" ON "messages"("conversation_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_profiles_userId_key" ON "affiliate_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_profiles_referralSlug_key" ON "affiliate_profiles"("referralSlug");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referredUserId_key" ON "referrals"("referredUserId");

-- CreateIndex
CREATE INDEX "referrals_affiliateId_status_idx" ON "referrals"("affiliateId", "status");

-- CreateIndex
CREATE INDEX "commission_logs_affiliateId_status_idx" ON "commission_logs"("affiliateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commission_logs_affiliateId_referralId_type_sourceStageId_key" ON "commission_logs"("affiliateId", "referralId", "type", "sourceStageId");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_channel_metrics_affiliateId_channel_key" ON "affiliate_channel_metrics"("affiliateId", "channel");

-- CreateIndex
CREATE INDEX "referral_custom_links_affiliateId_idx" ON "referral_custom_links"("affiliateId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_skill_assessments_providerProfileId_specialtyId_key" ON "provider_skill_assessments"("providerProfileId", "specialtyId");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_projectId_key" ON "contracts"("projectId");

-- CreateIndex
CREATE INDEX "project_amendments_clientId_status_idx" ON "project_amendments"("clientId", "status");

-- CreateIndex
CREATE INDEX "project_amendments_providerId_status_idx" ON "project_amendments"("providerId", "status");

-- CreateIndex
CREATE INDEX "project_amendments_contractId_idx" ON "project_amendments"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "contract_terms_versions_amendmentId_key" ON "contract_terms_versions"("amendmentId");

-- CreateIndex
CREATE UNIQUE INDEX "contract_terms_versions_contractId_version_key" ON "contract_terms_versions"("contractId", "version");

-- CreateIndex
CREATE INDEX "project_stages_contractId_status_idx" ON "project_stages"("contractId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_stages_contractId_stepOrder_key" ON "project_stages"("contractId", "stepOrder");

-- CreateIndex
CREATE INDEX "stage_deliveries_stageId_submittedAt_idx" ON "stage_deliveries"("stageId", "submittedAt");

-- CreateIndex
CREATE INDEX "accreditation_samples_providerProfileId_idx" ON "accreditation_samples"("providerProfileId");

-- CreateIndex
CREATE INDEX "accreditation_samples_providerSpecialtyId_idx" ON "accreditation_samples"("providerSpecialtyId");

-- CreateIndex
CREATE INDEX "assessment_attempts_providerSpecialtyId_idx" ON "assessment_attempts"("providerSpecialtyId");

-- CreateIndex
CREATE INDEX "assessment_attempts_providerProfileId_idx" ON "assessment_attempts"("providerProfileId");

-- CreateIndex
CREATE INDEX "disputes_status_createdAt_idx" ON "disputes"("status", "createdAt");

-- CreateIndex
CREATE INDEX "disputes_requestId_idx" ON "disputes"("requestId");

-- CreateIndex
CREATE INDEX "disputes_projectId_idx" ON "disputes"("projectId");

-- CreateIndex
CREATE INDEX "disputes_openedById_idx" ON "disputes"("openedById");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_referenceId_key" ON "withdrawals"("referenceId");

-- CreateIndex
CREATE INDEX "withdrawals_status_createdAt_idx" ON "withdrawals"("status", "createdAt");

-- CreateIndex
CREATE INDEX "withdrawals_userId_createdAt_idx" ON "withdrawals"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payout_attempts_senderBatchId_key" ON "payout_attempts"("senderBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "payout_attempts_payoutItemId_key" ON "payout_attempts"("payoutItemId");

-- CreateIndex
CREATE INDEX "payout_attempts_withdrawalId_status_idx" ON "payout_attempts"("withdrawalId", "status");

-- CreateIndex
CREATE INDEX "payout_attempts_status_createdAt_idx" ON "payout_attempts"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payout_attempts_withdrawalId_attemptNumber_key" ON "payout_attempts"("withdrawalId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "active_attempt_unique" ON "payout_attempts"("withdrawalId") WHERE (status IN ('PENDING','PROCESSING'));

-- CreateIndex
CREATE UNIQUE INDEX "paypal_webhook_events_paypalEventId_key" ON "paypal_webhook_events"("paypalEventId");

-- CreateIndex
CREATE INDEX "paypal_webhook_events_payoutAttemptId_idx" ON "paypal_webhook_events"("payoutAttemptId");

-- CreateIndex
CREATE INDEX "paypal_webhook_events_status_createdAt_idx" ON "paypal_webhook_events"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "client_onboarding_userId_key" ON "client_onboarding"("userId");

-- CreateIndex
CREATE INDEX "client_requests_clientProfileId_idx" ON "client_requests"("clientProfileId");

-- CreateIndex
CREATE INDEX "client_requests_specialtyId_idx" ON "client_requests"("specialtyId");

-- CreateIndex
CREATE INDEX "client_requests_status_idx" ON "client_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_referenceId_key" ON "wallet_transactions"("referenceId");

-- CreateIndex
CREATE INDEX "wallet_transactions_userId_createdAt_idx" ON "wallet_transactions"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "paypal_payments_reference_key" ON "paypal_payments"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "paypal_payments_paypalOrderId_key" ON "paypal_payments"("paypalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "paypal_payments_paypalCaptureId_key" ON "paypal_payments"("paypalCaptureId");

-- CreateIndex
CREATE INDEX "paypal_payments_userId_createdAt_idx" ON "paypal_payments"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "arb_payments_trackId_key" ON "arb_payments"("trackId");

-- CreateIndex
CREATE UNIQUE INDEX "arb_payments_bankPaymentId_key" ON "arb_payments"("bankPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "arb_payments_bankTransId_key" ON "arb_payments"("bankTransId");

-- CreateIndex
CREATE UNIQUE INDEX "arb_payments_walletTxId_key" ON "arb_payments"("walletTxId");

-- CreateIndex
CREATE INDEX "arb_payments_userId_createdAt_idx" ON "arb_payments"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "arb_payments_status_updatedAt_idx" ON "arb_payments"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscribers_email_key" ON "newsletter_subscribers"("email");

-- CreateIndex
CREATE INDEX "company_team_members_companyOwnerId_memberType_status_idx" ON "company_team_members"("companyOwnerId", "memberType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "company_team_members_companyOwnerId_email_key" ON "company_team_members"("companyOwnerId", "email");

-- CreateIndex
CREATE INDEX "marketing_assets_active_audience_sortOrder_idx" ON "marketing_assets"("active", "audience", "sortOrder");

-- CreateIndex
CREATE INDEX "rate_limit_counters_reset_at_idx" ON "rate_limit_counters"("reset_at");

-- CreateIndex
CREATE INDEX "accreditation_sample_events_sampleId_createdAt_idx" ON "accreditation_sample_events"("sampleId", "createdAt");

-- CreateIndex
CREATE INDEX "accreditation_proof_uploads_userId_providerSpecialtyId_stat_idx" ON "accreditation_proof_uploads"("userId", "providerSpecialtyId", "status");

-- CreateIndex
CREATE INDEX "accreditation_proof_uploads_sampleId_idx" ON "accreditation_proof_uploads"("sampleId");

-- CreateIndex
CREATE INDEX "chat_digest_state_user_id_last_digest_at_idx" ON "chat_digest_state"("user_id", "last_digest_at");

-- CreateIndex
CREATE INDEX "_ProviderProfileToSkill_B_index" ON "_ProviderProfileToSkill"("B");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_change_requests" ADD CONSTRAINT "profile_change_requests_affiliateProfileId_fkey" FOREIGN KEY ("affiliateProfileId") REFERENCES "affiliate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_modification_requests" ADD CONSTRAINT "profile_modification_requests_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_items" ADD CONSTRAINT "portfolio_items_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "educations" ADD CONSTRAINT "educations_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_gamification" ADD CONSTRAINT "provider_gamification_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_clientRequestId_fkey" FOREIGN KEY ("clientRequestId") REFERENCES "client_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "project_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_audit_logs" ADD CONSTRAINT "account_audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_verifications" ADD CONSTRAINT "otp_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_assignedEmployeeId_fkey" FOREIGN KEY ("assignedEmployeeId") REFERENCES "company_team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_projects" ADD CONSTRAINT "saved_projects_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_projects" ADD CONSTRAINT "saved_projects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_clientRequestId_fkey" FOREIGN KEY ("clientRequestId") REFERENCES "client_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalAttachment" ADD CONSTRAINT "ProposalAttachment_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_catalogs" ADD CONSTRAINT "service_catalogs_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_catalogs" ADD CONSTRAINT "service_catalogs_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_catalogs" ADD CONSTRAINT "service_catalogs_portfolioItemId_fkey" FOREIGN KEY ("portfolioItemId") REFERENCES "portfolio_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_catalogs" ADD CONSTRAINT "service_catalogs_accreditationSampleId_fkey" FOREIGN KEY ("accreditationSampleId") REFERENCES "accreditation_samples"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service_catalogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_assignedToTeamMemberId_fkey" FOREIGN KEY ("assignedToTeamMemberId") REFERENCES "company_team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_createdByTeamMemberId_fkey" FOREIGN KEY ("createdByTeamMemberId") REFERENCES "company_team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_services" ADD CONSTRAINT "coupon_services_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_services" ADD CONSTRAINT "coupon_services_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service_catalogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_primaryServiceId_fkey" FOREIGN KEY ("primaryServiceId") REFERENCES "service_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_beneficiaryServiceId_fkey" FOREIGN KEY ("beneficiaryServiceId") REFERENCES "service_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_targetServiceId_fkey" FOREIGN KEY ("targetServiceId") REFERENCES "service_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_assignedToTeamMemberId_fkey" FOREIGN KEY ("assignedToTeamMemberId") REFERENCES "company_team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offers" ADD CONSTRAINT "special_offers_createdByTeamMemberId_fkey" FOREIGN KEY ("createdByTeamMemberId") REFERENCES "company_team_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offer_redemptions" ADD CONSTRAINT "special_offer_redemptions_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "special_offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offer_redemptions" ADD CONSTRAINT "special_offer_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_offer_redemptions" ADD CONSTRAINT "special_offer_redemptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service_catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_favorites" ADD CONSTRAINT "marketplace_favorites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_favorites" ADD CONSTRAINT "marketplace_favorites_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service_catalogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_stages" ADD CONSTRAINT "service_stages_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service_catalogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialties" ADD CONSTRAINT "specialties_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_specialties" ADD CONSTRAINT "provider_specialties_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_specialties" ADD CONSTRAINT "provider_specialties_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_samples" ADD CONSTRAINT "work_samples_providerSpecialtyId_fkey" FOREIGN KEY ("providerSpecialtyId") REFERENCES "provider_specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proof_attachments" ADD CONSTRAINT "proof_attachments_workSampleId_fkey" FOREIGN KEY ("workSampleId") REFERENCES "work_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_audit_logs" ADD CONSTRAINT "ai_audit_logs_providerSpecialtyId_fkey" FOREIGN KEY ("providerSpecialtyId") REFERENCES "provider_specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_proposals" ADD CONSTRAINT "project_proposals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_proposals" ADD CONSTRAINT "project_proposals_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_milestones" ADD CONSTRAINT "proposal_milestones_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "project_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_profiles" ADD CONSTRAINT "affiliate_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_channel_handles" ADD CONSTRAINT "affiliate_channel_handles_affiliateProfileId_fkey" FOREIGN KEY ("affiliateProfileId") REFERENCES "affiliate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_logs" ADD CONSTRAINT "commission_logs_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_logs" ADD CONSTRAINT "commission_logs_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_channel_metrics" ADD CONSTRAINT "affiliate_channel_metrics_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_custom_links" ADD CONSTRAINT "referral_custom_links_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "affiliate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_skill_assessments" ADD CONSTRAINT "provider_skill_assessments_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_skill_assessments" ADD CONSTRAINT "provider_skill_assessments_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_amendments" ADD CONSTRAINT "project_amendments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_amendments" ADD CONSTRAINT "project_amendments_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_amendments" ADD CONSTRAINT "project_amendments_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_amendments" ADD CONSTRAINT "project_amendments_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_amendments" ADD CONSTRAINT "project_amendments_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_terms_versions" ADD CONSTRAINT "contract_terms_versions_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_deliveries" ADD CONSTRAINT "stage_deliveries_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accreditation_samples" ADD CONSTRAINT "accreditation_samples_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accreditation_samples" ADD CONSTRAINT "accreditation_samples_providerSpecialtyId_fkey" FOREIGN KEY ("providerSpecialtyId") REFERENCES "provider_specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_accreditation_submissions" ADD CONSTRAINT "provider_accreditation_submissions_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_accreditation_submissions" ADD CONSTRAINT "provider_accreditation_submissions_providerSpecialtyId_fkey" FOREIGN KEY ("providerSpecialtyId") REFERENCES "specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_accreditation_proofs" ADD CONSTRAINT "provider_accreditation_proofs_accreditationSubmissionId_fkey" FOREIGN KEY ("accreditationSubmissionId") REFERENCES "provider_accreditation_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_accreditation_audit_logs" ADD CONSTRAINT "provider_accreditation_audit_logs_accreditationSubmissionI_fkey" FOREIGN KEY ("accreditationSubmissionId") REFERENCES "provider_accreditation_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_providerSpecialtyId_fkey" FOREIGN KEY ("providerSpecialtyId") REFERENCES "provider_specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "client_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_againstUserId_fkey" FOREIGN KEY ("againstUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paypal_webhook_events" ADD CONSTRAINT "paypal_webhook_events_payoutAttemptId_fkey" FOREIGN KEY ("payoutAttemptId") REFERENCES "payout_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_onboarding" ADD CONSTRAINT "client_onboarding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_requests" ADD CONSTRAINT "client_requests_clientProfileId_fkey" FOREIGN KEY ("clientProfileId") REFERENCES "client_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_requests" ADD CONSTRAINT "client_requests_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paypal_payments" ADD CONSTRAINT "paypal_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arb_payments" ADD CONSTRAINT "arb_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_team_members" ADD CONSTRAINT "company_team_members_companyOwnerId_fkey" FOREIGN KEY ("companyOwnerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accreditation_sample_events" ADD CONSTRAINT "accreditation_sample_events_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "accreditation_samples"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accreditation_proof_uploads" ADD CONSTRAINT "accreditation_proof_uploads_providerSpecialtyId_fkey" FOREIGN KEY ("providerSpecialtyId") REFERENCES "provider_specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accreditation_proof_uploads" ADD CONSTRAINT "accreditation_proof_uploads_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "accreditation_samples"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProviderProfileToSkill" ADD CONSTRAINT "_ProviderProfileToSkill_A_fkey" FOREIGN KEY ("A") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProviderProfileToSkill" ADD CONSTRAINT "_ProviderProfileToSkill_B_fkey" FOREIGN KEY ("B") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

