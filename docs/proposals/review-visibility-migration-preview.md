# Review publication (visibility): migration preview (NOT EXECUTED)

Migration `20261017110000_review_visibility`: `ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT true;`
Apply AFTER `20261017100000_review_tags`.

## Why
The «نشر التقييم» checkbox on both rating pages used to send nothing; every review was public. It is now a real choice stored with the review.

## Effect on existing data
- Additive, one column. Every existing review gets `isPublic = true` (they are public today): no retroactive change of any old review's visibility, rating, comment, tags, dates or ids. No UPDATE/DELETE in the migration.
- Verified on isolated PostgreSQL (`src/services/pg-reviews.pg.test.ts`): a DB created from the previous `reviews` shape, two old rows; after the tags + visibility migrations ids/ratings/comments/dates are byte-identical, `isPublic = true`, `tags = {}`; running the visibility migration twice is harmless; the column is `NOT NULL DEFAULT true`.

## Behaviour
- `POST .../rate` and `POST .../stages/:stageId/rating` accept `publish` (boolean, optional; omitted = `true`, so old clients keep working). It is stored in `isPublic`.
- An UNPUBLISHED review (`isPublic = false`) stays readable by its author and the other party (rating-status, project pages), and by the admin. Editing stays disallowed.
- It NEVER reaches a public API: provider public profile reviews list, client public profile, marketplace service page, service cards (rating/count), `minRating` filter, `rating`/`top_rated` ordering (ranked in memory from published-only counts so unpublished counts cannot leak through the order). The public payload is a whitelist (no internal ids, no reviewer role).
- It does NOT enter any PUBLIC average/count/percentage: provider `clientRating` / `reviewsCount` / `fiveStarReviewsCount` (public profile), service rating/count, client `providerRatingAverage` / `providerReviewsCount` (public profile).
- Also fixed on the way: the service page review list and the service card average used to include provider -> client reviews (they carry the project's `serviceId`); both now read published CLIENT reviews only, like the service count already did.

## Two numbers, deliberately separate
| | Counts | Used by |
|---|---|---|
| PUBLIC rating | published (`isPublic = true`) client reviews | provider public profile, service pages/cards, client public profile |
| INTERNAL rating | every review, published or not | `User.ratingAverage`, `ProviderGamification.avgRating` (the level gate `deriveProviderProgression`), the provider's own dashboard counters, admin analytics |

A provider's level never depends on the reviewer's publish choice. The owner's self-preview of the public page returns the public block unchanged plus a separate owner-only `reviewsInternal` (`count`, `average`, `unpublishedCount`, and the unpublished reviews themselves) so the provider can still read what clients chose not to publish. Visitors never receive that key.

## Stage reviews (decision)
Stage reviews are client -> provider reviews and feed both averages exactly like project reviews (current behaviour kept). Each public list row carries `kind: 'PROJECT' | 'STAGE'` (+ `stageTitle`), so the count shown equals the rows the list can show. A stage review is never an account-level client rating.

## Rollback (`rollback.sql`): self-protecting
One transaction; its first statement REFUSES (raises, so nothing is dropped, even without `ON_ERROR_STOP`) when
- any review has `isPublic = false` ("ROLLBACK REFUSED: n review(s) are unpublished"): dropping the column would publish a privacy decision, or
- any review carries tags ("ROLLBACK REFUSED: n review(s) carry tags").
Verified: both refusals leave the column and the data intact; on clean data the rollback drops the empty column and the row is unchanged.
After hidden reviews exist, code rollback means redeploying the previous image: it ignores the extra column, but WOULD show hidden reviews publicly (old readers do not filter), so do not roll the code back while unpublished reviews exist.

## Order
migration (tags) -> migration (visibility) -> BE -> FE. The new BE selects `isPublic`; it must not run before the migration.
