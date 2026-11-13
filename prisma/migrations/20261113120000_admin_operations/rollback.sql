BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM admin_expenses) OR EXISTS (SELECT 1 FROM cashback_reviews) OR EXISTS (SELECT 1 FROM admin_content_pages) OR EXISTS (SELECT 1 FROM admin_broadcasts) THEN
  RAISE EXCEPTION 'Rollback refused: durable operational records exist. Roll back containers and preserve additive tables.';
 END IF;
END $$;
DROP TABLE admin_broadcast_deliveries;
DROP TABLE admin_broadcasts;
DROP TABLE admin_content_pages;
DROP TABLE admin_expenses;
DROP TABLE cashback_reviews;
COMMIT;
