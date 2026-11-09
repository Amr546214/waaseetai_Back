CREATE TABLE "notification_templates" (
  "id" TEXT PRIMARY KEY,
  "name" VARCHAR(80) NOT NULL,
  "title" VARCHAR(150) NOT NULL,
  "message" TEXT NOT NULL CHECK (char_length("message") BETWEEN 1 AND 2000),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "notification_templates_name_key" ON "notification_templates" ("name");
CREATE INDEX "notification_templates_updatedAt_id_idx" ON "notification_templates" ("updatedAt", "id");
