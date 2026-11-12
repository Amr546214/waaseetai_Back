-- Explicit cancelled state for projects closed by an admin cancellation. NOT EXECUTED on any shared database (dev / production): the team applies it on the server.
-- Additive: one new enum value, no row changes. The value is NOT used by this migration (PostgreSQL cannot use a new enum value in the transaction that adds it).
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
