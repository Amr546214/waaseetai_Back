# audit(marketer-completion): where the marketer percentage comes from, what it scores, what the UI can fill

Read-only audit, 2026-10-05, `main` (backend `4c6cb49`, frontend `9ccf77e`). Nothing changed, nothing deployed, no DB access. Marketer only.

## 1. Backend
- **Function:** `computeAffiliateCompletion` (`utils/completion-calculators.ts`), called by the private `MarketerProfileService.recalculateCompletion` (`services/marketer-profile.service.ts`) and once at role creation (`account-management.service.ts`, channels = 0).
- **Stored, not live:** the value is written to `AffiliateProfile.completionPercentage` and every read returns that stored column.
  - `GET /marketer/profile` (select includes `completionPercentage`) feeds the three marketer boxes; `GET /marketer/profile/public/:id` feeds the public card.
  - **No GET recomputes it** (unlike the provider #17 and client #18 now).
- **When it is written:**

| Event | Endpoint | Recomputes? |
|---|---|---|
| role creation | add-account / registration | yes (channels = 0) |
| avatar / bio saved | `PATCH /marketer/profile/marketing-info` | **yes** |
| channel added / removed | `POST` / `DELETE /marketer/profile/channels` | **yes** |
| bank request created | `PATCH /marketer/profile/bank-info` | no (writes only a `ProfileChangeRequest`) |
| identity request created | `POST /marketer/profile/requests` | no (same) |
| **admin approval** (IBAN, first/last name) | `POST /admin/.../affiliate-requests/:id/approve` -> `applyFieldChange` | **no -> stale** |
| generic `PUT /profiles/update` for an AFFILIATE (not used by the marketer UI) | profile.service | no (latent) |

- **Pending requests:** `ProfileChangeRequest.status` = `PENDING_AI_REVIEW` -> `PENDING_HUMAN_APPROVAL` -> `APPROVED_AND_APPLIED` / `REJECTED` / `WITHDRAWN`. `AffiliateProfile.iban` (the scored column) is written **only** on `APPROVED_AND_APPLIED`. A pending IBAN request is therefore indistinguishable from "no IBAN" in the score, the GET and the UI boxes.
- **Admin approval:** `applyFieldChange` writes `iban` / `firstName` / `lastName` and the request status in one transaction and **never calls the recompute**, so the stored percentage stays stale (typically 80% instead of 100%) until the marketer saves a bio/avatar or adds/removes a channel.
- **GET / setup:** `GET /marketer/profile` returns every field the pages bind (profile, user, channels), but no `missingItems`, no pending-request state and no recomputed completion. There is no separate "setup" GET (the wizard reuses `GET /marketer/profile`).

## 2. Frontend
- **No local percentage calculation** (unlike the old provider page). All three displays read `completionPercentage`: `profile/data` progress bar (`data.html:13-16`), `profile-setup` ("نسبة اكتمال الملف: N%", `profile-setup.ts:75`), `public` card (`public.html:46-49`, whose sub-text "معدل تحويل أعلى من المتوسط · لا بلاغات" is static marketing copy).
- **The marketer dashboard home and sidebar have no completion box.**
- **No missing-items box anywhere.** The only "what is missing" signal is the wizard review step (`profile-setup.html:153-155`) whose rows are computed independently of the percentage (`bio`, `channels.length`, `profile.iban`), and whose bank row shows "قيد المراجعة" only from an in-memory flag (`bankSubmitted`), so after a reload a pending bank request shows "لم يُضف" (same for `bankPending` / `identityPending` in `data.ts`).
- **Messages:** already honest after #31: bank/identity say "تم إرسال … للمراجعة" (`data.ts:422,479`, `profile-setup.ts:167`); bio/avatar say "تم حفظ …" (immediate writes). No place calls a review request "saved".
- **Hints to non-saving forms:** none that point at a form that cannot save. (Disabled placeholders exist: nationality select and the two ID uploads; nothing links to them.)
- **Withdraw page:** `hasBankInfo = !!profile.iban` (`withdraw.ts:59`); it sends the user to the profile data tab for the bank step, but it cannot tell "no IBAN" from "IBAN pending review".

## 3. Scoring table (`computeAffiliateCompletion`, total 100)
| Item | Weight | DB source | UI? | Saved? | Human review? | Approval triggers it? | Problem |
|---|---|---|---|---|---|---|---|
| Avatar | 15 | `AffiliateProfile.avatarUrl` or `User.avatarUrl` | data tab (upload/delete) | yes, immediate | no | n/a | the boxes show only the AffiliateProfile avatar while a legacy `User.avatarUrl` also scores; deleting leaves the User avatar scoring |
| Bio | 15 | `AffiliateProfile.bio` (non-blank) | data tab + wizard step 2 | yes, immediate | no | n/a | wizard accepts an empty bio (0 points, no warning); no server length validation (UI says 500) |
| >= 1 channel | 20 | `AffiliateChannelHandle` count | data tab + wizard step 3 | yes, immediate | no (display shows "محقق"/"قيد المراجعة" for the channel itself, not scored) | n/a | API has no validation (any platform/handle); "محقق" dot on the data tab is misleading |
| IBAN | 20 | `AffiliateProfile.iban` | data tab + wizard step 4 | **only as a `ProfileChangeRequest`** | **yes** (AI then human) | applies the column but **does not recompute** | pending looks like missing; stored % stale after approval; withdrawals read the same column |
| Names + email | 30 | `User.firstName/lastName/email` | read-only (names editable only via governed request, email never) | set at signup | names: yes | names: **no recompute** | always met at signup, not completable from the UI (free points) |

Maximum from the UI before any approval: **80%** (30 + avatar 15 + bio 15 + channel 20). After the IBAN approval: 100% **only if** a recompute happens (otherwise the stored value stays 80).

## 4. Fields shown in the UI that are not saved
| Where | Field | Why |
|---|---|---|
| data › basics | nationality select (disabled), ID front/back uploads (disabled) | placeholders; nothing is sent (`kycDocumentUrl` / `identityVerified` exist in the schema but nothing writes them) |
| data › basics | phone, national id | saved only as governed requests (not immediate); phone is not scored |
| data › bank | `swiftCode` | sent on every bank submit although no input exists |
| wizard step 1 | name / email / phone / referral link | read-only, sends nothing |

## 5. Counted but not completable from the UI
| Item | Points | Why |
|---|---|---|
| Names + email | 30 | no direct edit path (names via request, email none); only ever met by signup data |
| IBAN | 20 | completable only through a human approval (not by the user alone) |

## 6. Where the percentage can be stale
1. After admin approval of IBAN / first name / last name (no recompute).
2. After a bank/identity request is created (nothing to recompute, but the UI shows "لم يُضف" / "قيد المراجعة" from local state).
3. Any stored value that predates the current formula (no recompute on GET).
4. The legacy `PUT /profiles/update` AFFILIATE branch writes avatar/bio without recomputing (the marketer UI does not call it).
5. The request-number generator (`REQ-<4 digits>`, unique) can collide -> 500 on a bank/identity request (separate bug, noted).

## 7. PayPal / bank status (no change proposed here)
- **Marketer has no PayPal column.** `AffiliateProfile` has `bankName`, `accountHolderName`, `iban`, `swiftCode` and a free-text `payoutMethod` (default `BANK_TRANSFER`), but nothing for a PayPal destination; `profile.service.ts` explicitly strips `paypalPayoutEmail` for AFFILIATE.
- **Withdrawals are bank-based.** `WithdrawalService.createForMarketer` requires `AffiliateProfile.iban` and snapshots `iban` + `accountName` with `method: 'bank_transfer'` into the `Withdrawal` row.
- **Doing PayPal for marketers is NOT frontend-only**: it needs a new column (`AffiliateProfile.paypalPayoutEmail`), i.e. a **schema change + migration/ALTER on dev and prod (separate approval)**, backend changes in the marketer profile + withdrawal service (snapshot, validation, payout execution), and the governed-review question (is a payout destination change reviewed like the IBAN is today?). Client and provider have it only because their columns already existed.

## 8. Recommendation
The problem is clear and well bounded (no local formula, no boxes, one real staleness bug, pending state invisible). Proposed split, **not started**:
- **Backend PR:** formula as rules + `computeAffiliateMissingItems` (`key, label, points, hint, tab, status`; the IBAN item as `pending_review` when a request is in `PENDING_AI_REVIEW`/`PENDING_HUMAN_APPROVAL`); `GET /marketer/profile` returns recomputed `completionPercentage` + `missingItems` (+ synced); recompute on admin approval (IBAN/names) and on the other write paths; optionally minimal server validation for bio length and channel platform/handle.
- **Frontend PR:** backend-driven "لإكمال ملفك إلى 100%، أكمل التالي:" box on the data page and the wizard review, "قيد المراجعة" from real data (not the in-memory flag), withdraw page distinguishes "pending" from "missing", fix the misleading channel "محقق" dot and the static public-card copy.

### Decisions needed before any PR
1. **Pending IBAN:** keep it out of the score and show `pending_review` (provider convention), or count it once submitted?
2. **Names + email (30):** keep as free points (always met), or drop them from the score and renormalize over what the marketer can do (avatar / bio / channel / IBAN)?
3. **Bio:** any non-blank text (today) or a minimum length (the provider uses 50)?
4. **Channel:** is "at least one channel" enough, or only a verified one (the verification flow does not exist yet)?
5. **Server-side validation** (bio <= 500, channel platform enum / non-empty handle): include in the backend PR or leave?
6. **PayPal for marketers:** a separate decision (schema + migration + withdrawal rework); until then the IBAN stays the payout item.
