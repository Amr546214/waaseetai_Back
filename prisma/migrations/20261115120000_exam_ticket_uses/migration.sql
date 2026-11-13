-- Additive. Consumed SEB tickets must remain consumed across backend workers and restarts.
CREATE TABLE IF NOT EXISTS "exam_ticket_uses" (
  "jti" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "scope" TEXT NOT NULL CHECK ("scope" = 'SETUP_TEST'),
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "usedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "exam_ticket_uses_expiresAt_idx" ON "exam_ticket_uses" ("expiresAt");
