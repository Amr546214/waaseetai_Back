# audit(client-completion): where the client percentage comes from, what it scores, what the UI can actually fill

Read-only audit, 2026-10-05, `main` (backend `9b1cc6c`, frontend `18b56bd`). Nothing changed, nothing deployed, no DB access.

## 1. Where the number comes from
- **Always from the backend, stored.** `ClientProfile.completionPercentage` (BE `utils/completion-calculators.ts` `computeClientCompletion`). Every client screen reads it: `GET /profiles/me` (`currentProfileData.profileCompletionPercent`, resolved by `role-display-resolver`), `GET /dashboard/stats` (`summary.profileCompletionPercent`). **No local percentage formula exists on the client side** (unlike the provider). What *is* local: the edit page hint text (`profile-edit.ts getCompletionHint()`, a chain of `if`s on form values) and static banner copy (`profile.html:149`).
- **Recomputed (written) on:** role creation; `PUT /profiles/update` (CLIENT branch); `PUT /profiles/update/basics|contact` **only if firstName/lastName/avatarUrl are in the body**; `PUT /profiles/update/banking` with `paypalPayoutEmail`; `POST /client/profile/setup` (wizard). **Not** on identity/other banking calls, and **GET never recomputes** (unlike the provider after #17), so a stored value can go stale.
- `GET /profiles/me` returns everything the forms need (User + ClientProfile spread + display fields) but ClientProfile columns shadow User columns with the same name (`id`, `userId`, `city`, `idNumber`, `bankName`, `country`...), so the contact-tab city saved on `User.city` can read back as `ClientProfile.city`. `GET /client/profile/setup` returns the raw ClientProfile row (`{}` when none): enough for the wizard, but **no completion and no missing list**, and none of the User-level fields.
- `GET /client/company/dashboard` (company banner `pendingProfileCompletionRequired`) has **no backend route**.

## 2. The formula (verified) and every item
| # | Item | Weight | DB source | Has UI? | Saved? | Problem |
|---|---|---|---|---|---|---|
| 1 | firstName | 7.5 | ClientProfile.firstName (fallback User) | edit › basics | yes (`/update/basics`, no zod) | ok (seeded at signup) |
| 2 | lastName | 7.5 | same | same | yes | ok |
| 3 | phone | 7.5 | **User.phoneNumber** | read-only everywhere | set at signup (required) | always met; never editable |
| 4 | avatar | 7.5 | ClientProfile.avatarUrl `||` User.avatarUrl | edit › profile | yes | delete stores `''` but a legacy User avatar still counts |
| 5 | bio | 6 | ClientProfile.bio | edit › profile (both types) | yes | ok |
| 6 | companyName | 6 | ClientProfile.companyName | **company only** | yes | unreachable for individuals |
| 7 | companySize | 6 | ClientProfile.companySize | company only | yes | unreachable for individuals |
| 8 | industry | 6 | ClientProfile.industry | company only (edit) + wizard "المهنة الحالية" for everyone | yes | one column, two meanings; wizard fills it for individuals |
| 9 | website | 6 | ClientProfile.website | company only | yes | unreachable for individuals |
| 10 | idNumber | 10 | ClientProfile.idNumber (fallback User) | wizard step 1 only | yes (regex-checked) | edit › identity tab is inert; only the wizard fills it |
| 11 | **idExpiryDate** | 10 | **User.idExpiryDate** | none (edit identity tab is inert and never sends it) | **no writer anywhere** (moderation path commented out) | **counted, unreachable, can never fire** |
| 12 | PayPal | 20 (replaces 13-15) | ClientProfile.paypalPayoutEmail | edit › banking, **disabled** (`paypalSaveSupported=false`, PR #27 paused) | backend ready (`PUT /profiles/update/banking`) | unreachable until #27; form control `paypalEmail` != GET key `paypalPayoutEmail`, so it never prefills |
| 13 | iban | 6.67 | **User.ibanNumber** | wizard collects an IBAN | saved to **ClientProfile.iban** (different column) | counted column has no writer |
| 14 | bankName | 6.67 | ClientProfile.bankName (fallback User) | wizard | yes | the only bank item that can fire |
| 15 | accountHolder | 6.67 | **User.accountHolderName** | wizard collects it | saved to **ClientProfile.accountHolder** | counted column has no writer |

PayPal and the bank trio are alternatives (PayPal present = +20, else trio). Rounded, capped at 100.

**Max reachable from today's UI:** individual **59%** (36% if the wizard was skipped), company **77%** (60% without the wizard). With PayPal enabled: individual 72%, company 90%. **100% is unreachable for every client** (the `idExpiryDate` 10 has no writer).

## 3. Fields shown in the UI that are not saved
| Where | Field | Why |
|---|---|---|
| edit › profile | interests, LinkedIn/portfolio/personal links, language, timezone, notification toggles | not in the CLIENT schema/columns; already shown disabled with a note (#32) |
| edit › basics | email, phone | read-only, never sent |
| edit › contact | country | only used to pick the city list, never sent |
| edit › identity | id number, expiry/birth date, nationality, country*, city, ID images | whole tab inert (backend persists nothing, only flips `PENDING_VERIFICATION`) |
| edit › banking | **PayPal email (required `*`)**, payment method `*` | save disabled (`paypalSaveSupported=false`) |
| edit › security | password / MFA / sessions | static mock-up, labelled "غير مفعّل" |
| wizard | NAFATH button | toast only (endpoint exists, no UI calls it) |
| wizard | "wallet" payment type | requires the bank trio, stores no wallet data |
| wizard | identity/documents re-submit | an empty upload overwrites with `''` and resets `kycStatus` to PENDING |

## 4. Counted in the percentage but not completable from the UI
| Item | Points | Why not completable |
|---|---|---|
| User.idExpiryDate | 10 | no input, no writer |
| PayPal payout email | 20 | UI disabled until PR #27; control name mismatch |
| User.ibanNumber, User.accountHolderName | 13.3 | wizard writes `ClientProfile.iban/accountHolder` instead |
| companyName, companySize, website | 18 | hidden for CLIENT_INDIVIDUAL |

Saved but **not counted** (wizard, all required): dob, country, city, address, accountHolder, iban, paymentType, agreements, supporting docs.

## 5. Messages for the missing items
None that are reliable. Edit page: `getCompletionHint()` suggests KYC (the identity tab is inert) and PayPal (disabled) and never mentions company fields, so it can point at actions the user cannot do. Profile page banner: "أضف رقم الجوال والموقع الشخصي" (phone is mandatory at signup; "الموقع الشخصي" is not saved). Dashboard banner links to the wizard for "صورة شخصية وبيانات التواصل" (the wizard has no avatar). The edit page box is not refreshed after saving (only on load).

## 6. PayPal / PR #27 relationship
- The formula already treats PayPal as a full +20 substitute for the bank trio; the backend save (`PUT /profiles/update/banking` + `paypalPayoutEmail`) exists and works since the prod column was added on 2026-10-04.
- **The frontend switch is the blocker:** `profile-edit.ts` `paypalSaveSupported=false` and the disabled button are exactly PR #27's subject. Until #27 resumes, no client can earn the +20, and any "add PayPal" item shown to a client would point at a disabled form.
- Conflict to remember: a client `missingItems` list that includes PayPal must either wait for #27 or carry a "غير متاح حاليًا" state. Not touched here.

## 7. Recommendation
Both sides, backend first (same shape as the provider fix: rules-as-data, `missingItems` with `tab`, `pending_review`, compute on GET, recompute on write, `GET /client/profile/setup` also returning the completion). Frontend then shows a backend-driven box on the edit page, profile page and dashboard banner, and the local hint and wrong copy go away.

**It is not as clear-cut as the provider**, because "what counts" has to change and that is a product decision. Open decisions before a PR:
1. **Payout item:** PayPal only (+20) and drop the dead bank trio, or keep the trio until #27? (Dropping it now caps clients at 80% until #27 ships.)
2. **`idExpiryDate` (10):** remove from the score (no writer) or add a real way to fill it? Replace with items the wizard already collects (dob/country/city)?
3. **Individual vs company:** score only the inputs a given account type can fill (individuals lose companyName/size/website; weights renormalised to 100), or keep one formula?
4. Whether to recompute on GET (as done for the provider) to heal stale stored values.
