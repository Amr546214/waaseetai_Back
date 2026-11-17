-- ADDITIVE ONLY. NOT EXECUTED on dev/prod: the team applies it after a backup. One new table; no existing table or column is touched.
-- One identity, one account: the digest (country + normalised document number) is unique, so two accounts can never both hold an approved identity with the same number.
CREATE TABLE "identity_claims" (
    "digest" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "party" "IdentityCheckParty" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_claims_pkey" PRIMARY KEY ("digest")
);

CREATE INDEX "identity_claims_userId_idx" ON "identity_claims"("userId");

ALTER TABLE "identity_claims" ADD CONSTRAINT "identity_claims_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
