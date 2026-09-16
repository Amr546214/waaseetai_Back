import { z } from 'zod';
import { aiSchemaRegistry } from '../schema-registry';

export const PROFILE_INTELLIGENCE_SCHEMA_VERSION = '2026-09-15.v1';

export const PROFILE_INTELLIGENCE_SCHEMA_IDS = {
  sensitiveChangeReview: 'profile-intelligence.sensitive-change-review',
} as const;

const boundedText = z.string().min(1).max(700);
const boundedItem = z.string().min(1).max(300);

export const profileSensitiveChangeReviewSchema = z.object({
  reviewLevel: z.enum(['normal', 'elevated', 'manual_review_required']),
  concerns: z.array(boundedItem).max(5),
  missingVerification: z.array(boundedItem).max(5),
  recommendation: z.enum([
    'continue_standard_review',
    'request_additional_verification',
    'manual_review_required',
  ]),
  rationale: boundedText,
  summary: boundedText,
  humanReviewRequired: z.literal(true),
}).strict();

export type ProfileSensitiveChangeReviewOutput = z.infer<
  typeof profileSensitiveChangeReviewSchema
>;

aiSchemaRegistry.register<ProfileSensitiveChangeReviewOutput>({
  id: PROFILE_INTELLIGENCE_SCHEMA_IDS.sensitiveChangeReview,
  version: PROFILE_INTELLIGENCE_SCHEMA_VERSION,
  schema: profileSensitiveChangeReviewSchema,
  description:
    'Advisory sensitive profile-change review for human/manual review workflows.',
});
