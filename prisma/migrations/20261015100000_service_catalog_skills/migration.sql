-- Skills of a marketplace service (validated server-side against src/config/skills-catalog.config.ts). Additive only: one new column, existing rows get '{}'. NOT EXECUTED.
ALTER TABLE "service_catalogs" ADD COLUMN IF NOT EXISTS "skills" TEXT[] DEFAULT ARRAY[]::TEXT[];
