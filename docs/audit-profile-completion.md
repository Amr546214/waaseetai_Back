# audit(profile-completion): verify saved fields and completion scoring across roles

Read-only audit, 2026-10-05, both repos on `main` (frontend `b6eabee`, backend `2d0ee99`). Nothing was changed, deployed or written to any DB.
Code references: BE = `waseetai-backend/src`, FE = `angular-app/src/app`.

## 0. Scoring formulas (BE `utils/completion-calculators.ts`)
| Role | Inputs and points (sum 100) |
|---|---|
| Client (`computeClientCompletion`) | firstName 7.5, lastName 7.5, **User.phoneNumber** 7.5, avatar 7.5; ClientProfile bio 6, companyName 6, companySize 6, industry 6, website 6; idNumber 10, **User.idExpiryDate** 10; banking: `paypalPayoutEmail` = 20, else **User.ibanNumber / bankName / User.accountHolderName** 20/3 each |
| Provider (`computeProviderCompletion`) | avatar 10; firstName+lastName+headline+mainSpecialty 15; bio >= 50 chars 15; skills >= 1 10; portfolioItems >= 1 **or** websiteUrl 10; User.email+phone 10; country+city 10; **User.ibanNumber 10**; **User.idDocumentUrl 10** |
| Marketer (`computeAffiliateCompletion`) | avatar 15; bio 15; >= 1 channel 20; **AffiliateProfile.iban 20**; User firstName+lastName+email 30 |

## 1. The Provider "75%" screenshot
The screenshot is the **edit page** ("اكتمال الملف المهني", `provider-overview/profile/data/data.html:47-51`). That number is **not** the backend value: it comes from a separate frontend formula, `calculateCompletion()` in `data.ts:842-930`:

| Item (local formula) | Points | Reachable from the UI? |
|---|---|---|
| avatar | 10 | yes |
| firstName+lastName+headline+**hourlyRate+yearsOfExperience** | 10 | **no**: `data.html` has no control for hourlyRate / yearsOfExperience (grep empty); `loadProfile` patches `hourlyRate||0` (`data.ts:271`) so it stays 0 |
| bio >= 50 | 10 | yes |
| portfolioList.length > 0 | 10 | no UI to add portfolio items on the edit page |
| phone | 10 | yes |
| city+country | 10 | yes |
| PayPal valid | 15 | yes |
| ID document | 15 | **only after admin approval** (a pending request does not set `User.idDocumentUrl`; `loadProfile()` resets the card to the empty server value, `data.ts:304`) |
| "security" | +10 | hard-coded free points (`data.ts:905`) |

**The missing 25% = 10 (hourlyRate/yearsOfExperience: no input exists) + 15 (ID document still pending review).** So it is *neither* missing user data *nor* a field that fails to save: it is a stale local scoring formula plus one input that has no control, plus a governed document change that was not yet approved. (A provider without portfolio items would additionally lose 10 locally.)

The **server** value (dashboard home, public page) is a different number: for the same provider it is at most **80**, missing `User.ibanNumber` (10, **no provider UI sets it at all**: payout is PayPal now, which the formula never reads) and `User.idDocumentUrl` (10, pending approval).

## 2. Maximum reachable percentage today
| Role | Server value from the UI | Notes |
|---|---|---|
| Client individual | **59%** (36% without the wizard) | idExpiryDate (10) unreachable; company fields hidden for individuals (18); bank trio unreachable except `ClientProfile.bankName` (6.67); PayPal (+20) UI is switched off (`paypalSaveSupported=false`, PR #27 paused) |
| Client company | **77%** (60% without the wizard) | with PayPal enabled: individual 72%, company 90%; 100% never reachable (idExpiryDate has no writer anywhere) |
| Provider individual | **80% before approval**, 90% after the ID is approved, **100 unreachable** | no UI writes `User.ibanNumber`; the only admin screen for modification requests is the affiliates one (no provider review UI calls `POST /provider/profile/requests/:id/review`) |
| Provider wizard only (never opened edit) | **55%** | wizard never sets headline, never persists the avatar, writes the ID to `ProviderProfile.frontIdUrl` not `User.idDocumentUrl` |
| Provider company | same individual formula; **no company edit form exists** ("غير متاح حاليًا", `data.html:7-33`) | company accounts cannot satisfy identity/bio/location/ID through any company UI |
| Marketer | **80% before approval**, 100% after IBAN approval | **but the stored value stays 80** after approval (see 4.1) |

## 3. Field tables (condensed from the three read-only sub-audits)
Legend: Req = required visually; Payload = sent by the UI; Saved = where it ends up; Pts = completion points; ⚠ = mismatch.

### 3.1 Client
| UI label | Control | Req | Payload / endpoint | Backend accepts | Saved | Pts | Mismatch |
|---|---|---|---|---|---|---|---|
| الصورة الشخصية | avatarUrl | no | `avatarUrl` · PUT /profiles/update | yes | ClientProfile.avatarUrl | 7.5 | ⚠ delete stores `''` but a legacy User.avatarUrl still counts |
| اسم الشركة / حجم الشركة / مجال العمل / الموقع | companyName, companySize, industry, website | no | same call | yes | ClientProfile.* | 6 each | ⚠ hidden for CLIENT_INDIVIDUAL (18 pts unreachable); `industry` is also the wizard's "المهنة" (overwrites) |
| نبذة (bio) | bio | no (≤1000) | same | yes | ClientProfile.bio | 6 | — |
| الاسم الأول/الأخير | basics firstName/lastName | no | PUT /profiles/update/basics | no zod applied | ClientProfile.firstName/lastName | 7.5 each | ⚠ unvalidated server-side |
| الجوال | phoneNumber (read-only) | — | never sent | — | User.phoneNumber (set at signup) | 7.5 | ok |
| WhatsApp / المدينة | alternativePhone, city | no | PUT …/update/contact | allow-list | User.alternativePhone / User.city | 0 | ⚠ `getProfile` lets ClientProfile.city shadow User.city on reload |
| رقم الهوية (wizard) | details.idNumber | yes | POST /client/profile/setup | manual regex | ClientProfile.idNumber | 10 | — |
| تاريخ الميلاد / الدولة / المدينة / العنوان (wizard) | details.* | yes | same | manual | ClientProfile.dob/country/city/address | 0 | ⚠ required, saved, **not counted** |
| المهنة (wizard) | details.occupation | yes | same | manual | ClientProfile.industry | 6 | ⚠ key renamed |
| صور الهوية (wizard) | identity.* | no | same | manual | ClientProfile.frontIdUrl/backIdUrl, kycStatus=PENDING | 0 | ⚠ empty re-submit overwrites with `''` and resets VERIFIED |
| طريقة الاستلام / البنك (wizard) | bank.paymentType (bank/wallet only), bankName, accountHolder, iban | yes | same | manual (IBAN 24) | ClientProfile.bankName/accountHolder/iban | bankName 6.67 only | ⚠ accountHolder and iban saved to columns the formula does not read (User.*); no PayPal option in the wizard |
| تاريخ انتهاء الهوية (edit identity tab) | idExpiryDate | no | **never sent** (tab inert) | — | **not persisted anywhere** | (10) | ⚠ counted but unreachable |
| بريد PayPal (edit banking) | paypalEmail | yes | **not sent** (`paypalSaveSupported=false`) | PUT …/update/banking ready | ClientProfile.paypalPayoutEmail | (20) | ⚠ required in UI, not sent; control name `paypalEmail` ≠ GET key `paypalPayoutEmail`, so the form never prefills |

Other client findings: the edit-page progress box is not refreshed after save (only on load, `profile-edit.ts:290`); `GET /client/company/dashboard` (company banner) has no backend route; profile-page banner copy ("أضف رقم الجوال والموقع الشخصي") does not match the formula; a CLIENT PUT /profiles/update carrying provider-only keys would 500 (FE strips them).

### 3.2 Provider individual
| UI label | Control | Req | Payload / endpoint | Backend | Saved | Applies | Pts | Mismatch |
|---|---|---|---|---|---|---|---|---|
| الصورة | avatarUrl | no | PUT /provider/profile/basic-info | Cloudinary | ProviderProfile.avatarUrl | immediately | 10 | ⚠ edit form reloads from User.avatarUrl; wizard uploads but never sends it |
| الاسم / المسمى / التخصص | firstName, lastName, headline, specialty→mainSpecialty | yes | basic-info | required checks | ProviderProfile.* | immediately | 15 (block) | ⚠ wizard never sets headline (`jobTitle`→industry) and stores a category slug in mainSpecialty |
| الدولة/المدينة | country, city | yes | basic-info | none | ProviderProfile.country/city | immediately | 10 | — |
| الوصف المهني | bio | no (≤500) | basic-info | ≤500 | ProviderProfile.bio | immediately | 15 if ≥ 50 chars | ⚠ the 50-char threshold is never shown; a blank bio overwrites with `''` |
| المهارات | skills | no | PUT /provider/profile/skills | upserts any name | Skill + relation | immediately | 10 | ⚠ wizard rejects names not in Skill table, edit accepts any |
| معرض الأعمال (URL) | websiteUrl | no | basic-info | http(s) | ProviderProfile.websiteUrl | immediately | 10 | ⚠ edit page cannot add portfolio items; wizard's portfolioUrl/linkedin/website not sent |
| البريد / الجوال | email, phoneNumber (Contact tab) | yes | POST /provider/profile/sensitive-change + verify (OTP) | regex/unique | User.email/phoneNumber | after OTP | 10 | ⚠ no recompute after CONTACT apply |
| بريد PayPal | paypalPayoutEmail | yes | PUT /profiles/update | zod | ProviderProfile.paypalPayoutEmail | immediately | **0** | ⚠ not in the formula; only the *local* edit-page formula counts it (15) |
| (no control) | hourlyRate, yearsOfExperience, availabilityStatus, languages | — | sent from loaded values | none | ProviderProfile.* | — | local formula only | ⚠ no input exists |
| الهوية الوطنية | idDocumentUrl | yes | upload then sensitive-change DOCUMENTS | https only | User.idDocumentUrl **only on admin approval** | PENDING_HUMAN_REVIEW | 10 after approval | ⚠ no provider admin-review UI; pending upload invisible after reload |
| شهادة / السجل التجاري / VAT | certificatesUrl, commercialRegistration, vatCertificateUrl | no | same | https | on approval | pending | 0 | ⚠ empty strings overwrite on approval |
| IBAN | — | — | **no UI** | BANKING flow exists | User.ibanNumber | — | **10** | ⚠ counted, no UI path |

### 3.3 Provider company
No company edit form (`data.html:7-33`); `companyName` is written only by the add-account flow; company accounts use the individual wizard and formula.

### 3.4 Marketer
| UI label | Control | Req | Payload / endpoint | Backend | Saved | Applies | Pts | Mismatch |
|---|---|---|---|---|---|---|---|---|
| الصورة | avatarUrl | no | PATCH /marketer/profile/marketing-info | none (no zod) | AffiliateProfile.avatarUrl | immediately | 15 | ⚠ UI shows only AffiliateProfile avatar; scoring also counts User.avatarUrl |
| وصف تسويقي | bio | no (UI ≤500) | same | none (no length check) | AffiliateProfile.bio | immediately | 15 | ⚠ wizard saves an empty bio |
| نوع/معرّف القناة | channelForm.platform/handle | yes | POST /marketer/profile/channels | no enum/non-empty check | AffiliateChannelHandle | immediately | 20 | ⚠ API unvalidated |
| IBAN / اسم البنك / صاحب الحساب | bankForm.* | yes | PATCH /marketer/profile/bank-info | zod (all optional) | **ProfileChangeRequest only**; AffiliateProfile.iban written on admin approval | governed | 20 (iban only) | ⚠ **scoring points land only after approval and the stored % is not recomputed on approval** |
| swiftCode | bankForm.swiftCode | no input | sent every time | max 11 | on approval | governed | 0 | ⚠ sent, no UI |
| الاسم الأول/الأخير | basicsForm | no | POST /marketer/profile/requests | strict zod | User.firstName/lastName on approval | governed | 30 (names+email) | normally satisfied from signup |
| البريد | readonly | — | never | — | User.email | — | (30) | cannot change |
| الجنسية / مستندات الهوية | disabled controls | — | never sent | — | not persisted | — | 0 | UI placeholders |
| PayPal | none on marketer pages | — | — | — | — | — | 0 | marketer payouts remain IBAN-based (no stale-field problem, only the approval gap) |

## 4. Mismatches (all roles)
1. **Marketer: stored completion is never recomputed when the admin approves the IBAN** (`admin-affiliate-requests.service.ts` `applyFieldChange` writes `iban` and the request status only; `recalculateCompletion` runs only from `updateMarketingInfo`/`addChannel`/`removeChannel`). After approval the dashboard still shows 80% until an unrelated save. Provider approval *does* recompute (`provider-profile.service.ts:1093-1099`).
2. **Provider: the edit page shows a locally computed %, which disagrees with the server %** (two formulas, different weights; a third formula in the wizard ring; `profile-setup.ts:949` hard-codes 100 after the wizard; `level.html:62` has a hard-coded 92% bar).
3. **Provider: `User.ibanNumber` (10) has no UI**, and PayPal is not scored. A PayPal-only provider can never exceed 90% even after full approval.
4. **Client: the formula still scores the old bank trio / `User.idExpiryDate`**, which have no writer; PayPal (+20) is scored but its UI is disabled.
5. Required-but-not-counted (client wizard dob/country/city/address/accountHolder/iban), counted-but-no-UI (client idExpiryDate; provider iban; client company fields for individuals), required-but-not-sent (client PayPal; edit-identity tab), sent-but-ignored (marketer swiftCode; provider hourlyRate etc.).
6. No screen anywhere tells the user *which* items are missing, with links (the public page `missingHint` is a static string).

## 5. Fix plan (proposal, nothing applied)
1. **Backend scoring fix: yes, small and safe.**
   - Marketer: call `recalculateCompletion` after `approve()` applies IBAN / first-last name (inside or right after the transaction).
   - Provider: decide the scoring input for payout. Either count `ProviderProfile.paypalPayoutEmail` (10) instead of `User.ibanNumber`, or keep IBAN and add a UI. The platform direction is PayPal, so replace; trigger a recompute when PayPal is saved via `PUT /profiles/update`.
   - Client: after PayPal is enabled, drop the dead bank-trio fallback or point it at the columns the wizard writes; decide whether `idExpiryDate` stays scored (no writer exists).
   - Recompute on read (or on CONTACT apply) so stored values cannot go stale.
2. **Backend should return `missingItems` (yes).** One shared function returning `[{key, label, points, route/tab}]` next to each calculator, exposed on the existing profile endpoints (`/profiles/me`, `/provider/profile`, `/marketer/profile`, dashboard stats). It removes the three divergent frontend formulas.
3. **Frontend box "لإكمال ملفك إلى 100%، أكمل التالي:" (yes).** Render `missingItems` with deep links to the exact tab/step; replace the provider edit-page local `calculateCompletion()` with the server value; show "قيد المراجعة" for items pending admin approval (needs the pending request list; the marketer wizard already loses this on reload).
4. Frontend small fixes: refresh the client edit box after save, remove hard-coded 100/92, add hourlyRate/yearsOfExperience controls or drop them from the local logic (superseded by 3), show the 50-character bio hint.

**Cause of the 75% is identified** (stale local formula: hourlyRate/yearsOfExperience with no input + pending ID document), so a PR for the provider display fix is justified once approved. The scoring changes in 1 touch what "complete" means per role and should be confirmed first.
