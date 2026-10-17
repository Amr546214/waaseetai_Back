-- NOT EXECUTED. Requires the lead's authorization. Review publication: the reviewer's publish choice.
-- Additive: one NOT NULL column with default TRUE. Every existing review is public today, so every existing row becomes isPublic = true:
-- no retroactive change of any old review's visibility, rating, comment, tags, dates or ids.
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT true;
