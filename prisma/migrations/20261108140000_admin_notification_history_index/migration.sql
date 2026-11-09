-- Supports newest-first administrative history without sorting the notification table.
CREATE INDEX "notifications_createdAt_id_idx" ON "notifications"("createdAt", "id");
