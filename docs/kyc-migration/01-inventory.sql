-- READ-ONLY inventory of legacy KYC asset values. NOT EXECUTED. Run with PGOPTIONS='-c default_transaction_read_only=on'.
-- psql -At -F ',' -f 01-inventory.sql > inventory.csv   (header row is the first SELECT's alias line; keep it)
SELECT 'table','column','id','value';
SELECT 'client_profiles','frontIdUrl', id::text, "frontIdUrl" FROM client_profiles WHERE "frontIdUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'client_profiles','backIdUrl', id::text, "backIdUrl" FROM client_profiles WHERE "backIdUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'client_profiles','supportingDocsUrl', id::text, "supportingDocsUrl" FROM client_profiles WHERE "supportingDocsUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'provider_profiles','frontIdUrl', id::text, "frontIdUrl" FROM provider_profiles WHERE "frontIdUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'provider_profiles','backIdUrl', id::text, "backIdUrl" FROM provider_profiles WHERE "backIdUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'provider_profiles','supportingDocsUrl', id::text, "supportingDocsUrl" FROM provider_profiles WHERE "supportingDocsUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'provider_profiles','certUrls', id::text || '#' || (o.ord - 1), o.url FROM provider_profiles p, LATERAL unnest(p."certUrls") WITH ORDINALITY AS o(url, ord) WHERE o.url LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'client_onboarding','documentUrl', id::text, "documentUrl" FROM client_onboarding WHERE "documentUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'users','idDocumentUrl', id::text, "idDocumentUrl" FROM users WHERE "idDocumentUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'users','vatCertificateUrl', id::text, "vatCertificateUrl" FROM users WHERE "vatCertificateUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'proof_attachments','fileUrl', id::text, "fileUrl" FROM proof_attachments WHERE "fileUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'provider_accreditation_proofs','fileUrl', id::text, "fileUrl" FROM provider_accreditation_proofs WHERE "fileType" = 'PROOF_DOCUMENT' AND "fileUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'affiliate_profiles','kycDocumentUrl', id::text, "kycDocumentUrl" FROM affiliate_profiles WHERE "kycDocumentUrl" LIKE 'https://res.cloudinary.com/%'
UNION ALL SELECT 'certificates','credentialUrl', id::text, "credentialUrl" FROM certificates WHERE "credentialUrl" LIKE 'https://res.cloudinary.com/%';
