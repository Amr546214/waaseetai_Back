import { z } from 'zod';
import { sanitizedText } from '../utils/sanitize-text';

// The only fields a marketer/affiliate can request a governed change for via
// this endpoint. Deliberately NOT a generic { fieldType, requestedValue }
// shape — the field type is derived from which named property is present,
// never taken directly from the client, so an arbitrary/unsupported
// SensitiveFieldType can never reach the service layer from this route.
//
// EMAIL is deliberately excluded (decision, post-safety-review): it is the
// identity key Google OAuth's existing-user lookup matches on
// (auth.repository.ts#findByEmail — by email only, no googleId fallback),
// and this flow has no email-ownership verification step. Letting an admin
// silently reassign it here could permanently lock out a Google-authenticated
// affiliate with no password set. Fixing that properly means either
// revisiting the OAuth lookup or adding an email-OTP step — both explicitly
// out of scope for this task. `.strict()` below means a client sending
// `email` gets a validation error rather than having it silently dropped.
export const CreateIdentityRequestSchema = z.object({
  firstName: sanitizedText(z.string().trim().min(1).max(50)).optional(),
  lastName: sanitizedText(z.string().trim().min(1).max(50)).optional(),
  nationalId: z.string().trim().min(1).max(20).optional(),
  phoneNumber: z.string().trim().min(1).max(20).optional()
}).strict().refine(
  data => data.firstName !== undefined || data.lastName !== undefined || data.nationalId !== undefined || data.phoneNumber !== undefined,
  { message: 'يجب تحديد حقل واحد على الأقل لتعديله' }
);

export type CreateIdentityRequestDto = z.infer<typeof CreateIdentityRequestSchema>;
