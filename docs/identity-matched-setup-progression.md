# Matched identity data opens setup, not KYC approval

When `IDENTITY_AUTO_CHECK=on`, the owner identity gate may return `status: UNDER_REVIEW`, `automaticCheck: MATCHED`, `canAdvance: true`. Client/provider setup can then continue and finish without waiting for an administrator. This is the owner-approved policy; it does not grant `VERIFIED`, a verified badge, an identity claim, or an approval digest, and does not decide/remove the existing human KYC review.

Eligibility requires the latest persisted check to be DONE with MATCH for the private legal name, birth date and document number, for the exact current front-image reference and registered-data digest (including issuing country/type). A readable/uploaded image alone, an incomplete/mismatched/unreadable result, an unavailable check, or an obsolete name/image result never qualifies. Rejected and missing identity states stay closed. Changing data requires a new matching check. Final setup requests cannot replace the evidence while relying on a previous match.

The existing provider exception permitting later setup steps while documents are under review is unchanged. Full KYC approval remains manual for all roles; the marketer wizard already proceeds independently of document approval.

The response may include automaticCheck CHECKING, NOT_CHECKED or NEEDS_REVIEW. No raw OCR text is added. Existing installations with automatic checking off retain their previous gate behavior. No schema migration is added. Enable the existing check flag only with its deployed table and configured real AI comparison service. Existing image-format/size limits and unavailable-service fallback are unchanged.

Validation uses actual PostgreSQL persistence for individual/company client/provider cases and a synthetic AI double. It proves progression guards and unchanged KYC state, not real document-reading accuracy. Deployment still needs a signed-in test with a real private upload and the real AI response. This change is independent of SEB: restricted exams remain dev-only under their existing configuration.
