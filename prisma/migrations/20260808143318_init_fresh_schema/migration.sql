-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CLIENT_COMPANY', 'CLIENT_INDIVIDUAL', 'PROVIDER_COMPANY', 'PROVIDER_INDIVIDUAL', 'MARKETING_BROKER', 'EMPLOYEE', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'SUSPENDED_REVIEW');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING_AI_REVIEW', 'PENDING_HUMAN_APPROVAL', 'APPROVED_AND_APPLIED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SensitiveFieldType" AS ENUM ('IBAN', 'NATIONAL_ID', 'PHONE_NUMBER', 'EMAIL');

-- CreateEnum
CREATE TYPE "ModificationStatus" AS ENUM ('IN_AI_REVIEW', 'PENDING_HUMAN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AIAuditResult" AS ENUM ('PASSED', 'NEEDS_HUMAN_REVIEW', 'FLAGGED');

-- CreateEnum
CREATE TYPE "KYCStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('AVAILABLE', 'BUSY', 'OFFLINE');

-- CreateEnum
CREATE TYPE "RuleType" AS ENUM ('GAIN', 'LOSS');

-- CreateEnum
CREATE TYPE "LogCategory" AS ENUM ('ROLE_ADDITION', 'PROFILE_COMPLETION', 'SECURITY_CHANGE');

-- CreateEnum
CREATE TYPE "LogStatus" AS ENUM ('IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "OtpType" AS ENUM ('EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'OPEN', 'IN_PROGRESS', 'AWAITING_DELIVERY', 'PENDING_APPROVAL', 'COMPLETED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'DRAFT', 'IN_AI_REVIEW', 'SUBMITTED', 'UNDER_NEGOTIATION', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('HELD', 'RELEASED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ModelStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SpecialtyVerificationStatus" AS ENUM ('PENDING_PROOF', 'PENDING_AUDIT', 'PENDING_TEST', 'UNDER_AI_REVIEW', 'TEST_REQUIRED', 'APPROVED', 'REJECTED', 'LOCKED_OUT');

-- CreateEnum
CREATE TYPE "TestSessionStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'TIMED_OUT', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('ALL', 'OFFERS', 'PROJECTS', 'FINANCIAL', 'AI');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'FILE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('SENT', 'DELIVERED', 'READ');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'QUALIFIED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "SourceChannel" AS ENUM ('TIKTOK', 'X_TWITTER', 'INSTAGRAM', 'LINKEDIN', 'OTHER');

-- CreateEnum
CREATE TYPE "CommissionType" AS ENUM ('NEW_CLIENT_REQUEST', 'FIRST_PROJECT_COMPLETED', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "ProofFileType" AS ENUM ('PROOF_DOCUMENT', 'WORK_SAMPLE');

-- CreateEnum
CREATE TYPE "AccreditationStatus" AS ENUM ('DRAFT', 'PENDING_AI_REVIEW', 'PASSED', 'NEEDS_MANUAL_REVIEW', 'REJECTED');

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('IN_PROGRESS', 'STREAMING', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "accountType" "AccountType" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phoneCountryCode" TEXT NOT NULL DEFAULT '+966',
    "phoneNumber" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "avatarUrl" TEXT,
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
    "totalGmvAmount" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "completedProjectsCount" INTEGER NOT NULL DEFAULT 0,
    "ratingAverage" DOUBLE PRECISION DEFAULT 0.0,
    "tierLevel" TEXT DEFAULT 'Bronze',
    "aiRiskScore" INTEGER NOT NULL DEFAULT 10,
    "aiRiskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "aiSuspiciousNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
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
    "websiteUrl" TEXT,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,

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
    "rating" DOUBLE PRECISION NOT NULL,
    "comment" TEXT,
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
    "projectId" TEXT NOT NULL,
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
    "portfolioItemId" TEXT,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_catalogs_pkey" PRIMARY KEY ("id")
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
    "publicSampleUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "fileBytes" INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE "specialty_tests" (
    "id" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "durationMins" INTEGER NOT NULL DEFAULT 15,
    "passScore" DOUBLE PRECISION NOT NULL DEFAULT 70.0,
    "questions" JSONB NOT NULL,

    CONSTRAINT "specialty_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_submissions" (
    "id" TEXT NOT NULL,
    "providerSpecialtyId" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty_test_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerSpecialtyId" TEXT NOT NULL,
    "status" "TestSessionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "totalQuestions" INTEGER NOT NULL DEFAULT 20,
    "correctAnswers" INTEGER NOT NULL DEFAULT 0,
    "scorePercentage" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "antiCheatViolations" INTEGER NOT NULL DEFAULT 0,
    "violationEvents" JSONB,
    "questionsPayload" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "specialty_test_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_question_submissions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "subSpecialtyTag" TEXT NOT NULL,
    "selectedIndex" INTEGER NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,
    "timeTakenSec" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_question_submissions_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "offer_id" TEXT,
    "client_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
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
    "avatarUrl" TEXT,
    "bio" TEXT,
    "bankName" TEXT,
    "accountHolderName" TEXT,
    "iban" TEXT,
    "swiftCode" TEXT,
    "identityVerified" BOOLEAN NOT NULL DEFAULT false,
    "kycDocumentUrl" TEXT,
    "payoutMethod" TEXT DEFAULT 'BANK_TRANSFER',
    "minimumPayoutAmount" DOUBLE PRECISION NOT NULL DEFAULT 100.0,
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
CREATE TABLE "provider_accreditation_submissions" (
    "id" TEXT NOT NULL,
    "providerProfileId" TEXT NOT NULL,
    "providerSpecialtyId" TEXT NOT NULL,
    "status" "AccreditationStatus" NOT NULL DEFAULT 'PENDING_AI_REVIEW',
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
CREATE INDEX "users_accountType_status_idx" ON "users"("accountType", "status");

-- CreateIndex
CREATE INDEX "users_aiRiskScore_idx" ON "users"("aiRiskScore");

-- CreateIndex
CREATE INDEX "users_lastActiveAt_idx" ON "users"("lastActiveAt");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

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
CREATE INDEX "projects_providerId_status_idx" ON "projects"("providerId", "status");

-- CreateIndex
CREATE INDEX "projects_clientId_status_idx" ON "projects"("clientId", "status");

-- CreateIndex
CREATE INDEX "projects_status_createdAt_idx" ON "projects"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "saved_projects_providerId_projectId_key" ON "saved_projects"("providerId", "projectId");

-- CreateIndex
CREATE INDEX "proposals_providerId_status_createdAt_idx" ON "proposals"("providerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "proposals_projectId_status_idx" ON "proposals"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "escrows_projectId_key" ON "escrows"("projectId");

-- CreateIndex
CREATE INDEX "service_catalogs_providerId_idx" ON "service_catalogs"("providerId");

-- CreateIndex
CREATE INDEX "service_catalogs_status_idx" ON "service_catalogs"("status");

-- CreateIndex
CREATE INDEX "service_catalogs_specialtyId_idx" ON "service_catalogs"("specialtyId");

-- CreateIndex
CREATE INDEX "service_stages_serviceId_idx" ON "service_stages"("serviceId");

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
CREATE INDEX "specialty_tests_specialtyId_idx" ON "specialty_tests"("specialtyId");

-- CreateIndex
CREATE INDEX "test_submissions_providerSpecialtyId_idx" ON "test_submissions"("providerSpecialtyId");

-- CreateIndex
CREATE INDEX "test_submissions_testId_idx" ON "test_submissions"("testId");

-- CreateIndex
CREATE INDEX "specialty_test_sessions_userId_idx" ON "specialty_test_sessions"("userId");

-- CreateIndex
CREATE INDEX "specialty_test_sessions_providerSpecialtyId_status_idx" ON "specialty_test_sessions"("providerSpecialtyId", "status");

-- CreateIndex
CREATE INDEX "test_question_submissions_sessionId_idx" ON "test_question_submissions"("sessionId");

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
CREATE UNIQUE INDEX "conversations_project_id_provider_id_key" ON "conversations"("project_id", "provider_id");

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
CREATE UNIQUE INDEX "affiliate_channel_metrics_affiliateId_channel_key" ON "affiliate_channel_metrics"("affiliateId", "channel");

-- CreateIndex
CREATE INDEX "referral_custom_links_affiliateId_idx" ON "referral_custom_links"("affiliateId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_skill_assessments_providerProfileId_specialtyId_key" ON "provider_skill_assessments"("providerProfileId", "specialtyId");

-- CreateIndex
CREATE INDEX "assessment_attempts_providerSpecialtyId_idx" ON "assessment_attempts"("providerSpecialtyId");

-- CreateIndex
CREATE INDEX "assessment_attempts_providerProfileId_idx" ON "assessment_attempts"("providerProfileId");

-- CreateIndex
CREATE INDEX "_ProviderProfileToSkill_B_index" ON "_ProviderProfileToSkill"("B");

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
ALTER TABLE "saved_projects" ADD CONSTRAINT "saved_projects_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_projects" ADD CONSTRAINT "saved_projects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalAttachment" ADD CONSTRAINT "ProposalAttachment_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_catalogs" ADD CONSTRAINT "service_catalogs_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_catalogs" ADD CONSTRAINT "service_catalogs_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "skills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_catalogs" ADD CONSTRAINT "service_catalogs_portfolioItemId_fkey" FOREIGN KEY ("portfolioItemId") REFERENCES "portfolio_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "specialty_tests" ADD CONSTRAINT "specialty_tests_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_submissions" ADD CONSTRAINT "test_submissions_providerSpecialtyId_fkey" FOREIGN KEY ("providerSpecialtyId") REFERENCES "provider_specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_submissions" ADD CONSTRAINT "test_submissions_testId_fkey" FOREIGN KEY ("testId") REFERENCES "specialty_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty_test_sessions" ADD CONSTRAINT "specialty_test_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty_test_sessions" ADD CONSTRAINT "specialty_test_sessions_providerSpecialtyId_fkey" FOREIGN KEY ("providerSpecialtyId") REFERENCES "provider_specialties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_question_submissions" ADD CONSTRAINT "test_question_submissions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "specialty_test_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_proposals" ADD CONSTRAINT "project_proposals_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_proposals" ADD CONSTRAINT "project_proposals_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_milestones" ADD CONSTRAINT "proposal_milestones_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "project_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "_ProviderProfileToSkill" ADD CONSTRAINT "_ProviderProfileToSkill_A_fkey" FOREIGN KEY ("A") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProviderProfileToSkill" ADD CONSTRAINT "_ProviderProfileToSkill_B_fkey" FOREIGN KEY ("B") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

