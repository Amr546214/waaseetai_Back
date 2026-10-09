# KYC legacy-asset migration — DEV ONLY dry-run plan (NOT EXECUTED; local, not committed)

## What would move (dev DB waseetai_db_dev, read-only inventory 2026-10-07; legacy = value still a public https://res.cloudinary.com URL)
| table.column | assets |
|---|---|
| client_profiles.frontIdUrl / backIdUrl / supportingDocsUrl | 3 / 3 / 2 |
| provider_profiles.frontIdUrl / backIdUrl | 6 / 5 |
| provider_profiles.certUrls (array elements) | 4 |
| proof_attachments.fileUrl | 3 |
| users.idDocumentUrl, users.vatCertificateUrl, client_onboarding.documentUrl, certificates.credentialUrl, affiliate_profiles.kycDocumentUrl | 0 |
| **Total** | **26 Cloudinary assets** (some rows may share an asset; the script de-duplicates by public_id) |
Out of scope: public work samples (accreditation_samples attachments), avatars, portfolio, anything already `private:`.
Files uploaded after the private-storage deploy are already private and are not touched (the inventory only selects public URLs).
01-inventory.sql now also lists affiliate_profiles.kycDocumentUrl (PR-F; expected 0).

## Steps (nothing is run until the owner says so explicitly)
1. Inventory (read-only, `PGOPTIONS='-c default_transaction_read_only=on'`) → `inventory.csv` (kept, reviewed by hand; contains URLs, so it stays off git and out of chat).
2. Backup — run by the team on the server: `pg_dump -Fc -t client_profiles -t provider_profiles -t proof_attachments -t users -t client_onboarding -t affiliate_profiles waseetai_db_dev > pre-kyc-migration-dev.dump` + a copy of `inventory.csv`. Cloudinary side: the rename is reversible, so the "backup" of the assets is `mapping.csv` (old public_id ↔ new reference).
3. Dry run: `node 02-rename-to-authenticated.js inventory.csv` (default = dry run: prints counts and writes `mapping.dry.csv`; renames nothing).
4. Owner approval of the dry-run output.
5. Execute (one maintenance window, dev only): `CONFIRM=yes node 02-rename-to-authenticated.js inventory.csv --execute` (Cloudinary `type=upload` → `authenticated`, `invalidate:true`, writes `mapping.csv`) → `node 03-generate-db-update.js mapping.csv > 03-db-update.NOT-EXECUTED.sql` → review → apply in ONE transaction, each UPDATE guarded by `WHERE col = old_url`.
6. Verify: old public URL → 401/404; `POST /api/kyc-documents/access-link` opens each document for its owner and for an admin; row counts per column equal the inventory; `private:` count = 26.

## Rollback
- Assets: `node 04-rollback.js mapping.csv --execute` (renames back to `type=upload`).
- DB: `04-rollback-db.NOT-EXECUTED.sql` (generated with the update; restores the exact old URLs), or `pg_restore` of the dump from step 2.
- Risk window: between step 5 and 6 a legacy-URL reader (old cached page) would 404; the backend already serves both forms (legacy → "legacy" link, private → signed link), so no code change is needed in either direction.

## Prod
Not planned here. Prod inventory (owner's earlier counts): ~20 assets; same procedure after the dev run is verified.
