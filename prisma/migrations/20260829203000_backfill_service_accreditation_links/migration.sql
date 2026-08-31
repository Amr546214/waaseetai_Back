UPDATE "service_catalogs" AS service
SET "accreditationSampleId" = verified_sample.id
FROM (
  SELECT DISTINCT ON (profile."userId", provider_specialty."specialtyId")
    sample.id,
    profile."userId",
    provider_specialty."specialtyId"
  FROM "accreditation_samples" AS sample
  INNER JOIN "provider_profiles" AS profile
    ON profile.id = sample."providerProfileId"
  INNER JOIN "provider_specialties" AS provider_specialty
    ON provider_specialty.id = sample."providerSpecialtyId"
  WHERE sample.status = 'AI_VERIFIED'
  ORDER BY profile."userId", provider_specialty."specialtyId", sample."createdAt" DESC
) AS verified_sample
WHERE service."providerId" = verified_sample."userId"
  AND service."specialtyId" = verified_sample."specialtyId"
  AND service."accreditationSampleId" IS NULL;
