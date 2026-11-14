-- Image rollback should retain these additive columns. Never discard published copy automatically.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM admin_content_pages WHERE "draftCopy" IS NOT NULL OR "publishedCopy" IS NOT NULL) THEN RAISE EXCEPTION 'CMS copy exists: retain the additive columns'; END IF; END $$;
ALTER TABLE admin_content_pages DROP COLUMN "draftCopy", DROP COLUMN "publishedCopy";
