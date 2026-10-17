# Review tags: migration preview (NOT EXECUTED)

Migration `20261017100000_review_tags`: `ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];`

## Why
The rating pages show quick-pick tags (client: جودة عالية، التزام بالموعد، تواصل ممتاز، احترافية، مرونة في التعديلات، قيمة مقابل السعر; provider: توصيات واضحة، تعاون ممتاز، ردود سريعة، متطلبات منظمة، احترام المواعيد، قيمة عادلة للعمل) but the old code never stored them. The saved-review card must show what the reviewer really chose.

## Effect on existing data
- Additive, one column. Every existing review gets `{}` (no tags): rating, comment, dates, ids and the provider averages are NOT touched. The pages show "no tags" for them, never invented tags.
- Verified on an isolated PostgreSQL: an old review (4 stars, its comment) is identical after the migration and has `tags = {}`; running the migration twice is harmless; `prisma migrate diff` after it shows no drift for `reviews`.

## Rollback (`rollback.sql`) — self-protecting
Runs in one transaction; its first statement REFUSES (raises an exception, so nothing is dropped, even without `ON_ERROR_STOP`) when any review carries tags. Verified: with one review holding tags → "ROLLBACK REFUSED: 1 review(s) carry tags"; the column stays; after the tags are cleared the rollback drops the empty column and the old review is unchanged.
After tags exist, code rollback means redeploying the previous image: it ignores the extra column and the existing reviews keep reading normally.

## Order
The new backend (which reads/writes `tags`, and whose full-row review reads include the column) must NOT run before this migration. Order: migration → BE → FE.

## Publication (current behaviour, unchanged)
Reviews are public immediately; there is no stored "publish" choice (the checkbox on the rating pages sends nothing). Public data: provider profile (unauthenticated): stars, comment, tags, date, reviewer first/last name + avatar, project title (internal ids are no longer sent). Client profile (public): stars, comment, date, provider name. Deciding what the checkbox should do (hide a review? hide the name?) is an owner decision.
