-- NOT EXECUTED. Preview only. Requires owner approval.
-- Reviews keep the quick-pick tags the reviewer selected with the stars (until now the pages showed the chips but never stored them).
-- Additive: one column with an empty-array default; existing rows get '{}' (no tags), which the pages show as "no tags", never as invented ones.
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
