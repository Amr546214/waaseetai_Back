UPDATE "service_catalogs"
SET
  "status" = 'PUBLISHED',
  "approvedAt" = COALESCE("approvedAt", CURRENT_TIMESTAMP)
WHERE "status" IN ('PENDING_APPROVAL', 'UNDER_REVIEW', 'APPROVED');
