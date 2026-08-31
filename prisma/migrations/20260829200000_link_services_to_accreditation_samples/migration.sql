ALTER TABLE "service_catalogs"
ADD COLUMN "subSpecialty" TEXT,
ADD COLUMN "accreditationSampleId" TEXT;

CREATE INDEX "service_catalogs_accreditationSampleId_idx"
ON "service_catalogs"("accreditationSampleId");

ALTER TABLE "service_catalogs"
ADD CONSTRAINT "service_catalogs_accreditationSampleId_fkey"
FOREIGN KEY ("accreditationSampleId")
REFERENCES "accreditation_samples"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
