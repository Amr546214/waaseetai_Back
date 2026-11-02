-- platform_settings: optimistic-concurrency version per key (additive; every existing row starts at 1). NOT EXECUTED on dev until the plan is approved.
-- Rollback: ALTER TABLE "platform_settings" DROP COLUMN "version";
ALTER TABLE "platform_settings" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
