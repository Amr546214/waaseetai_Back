# WaseetAI — blocking issues per endpoint

Prepared 2026-10-02 from live probes against the Cloud Run service using **synthetic data only**
(no real users, projects or disputes). No credentials appear in this document.
Every request below was sent with `Authorization: Bearer <redacted>`.

Status legend: **WIRED** = integrated and working · **BLOCKED** = integrated nowhere because of the issue below.

Cross-cutting facts that apply to everything below:

- Unknown top-level request keys are silently stripped, so we cannot "try" extra fields to discover optional ones. Every optional field must be documented.
- Required fields are discoverable through `VALIDATION_ERROR` details (that is how we mapped most contracts). Optional fields are not.
- Our backend only knows opaque ids to send (`projectId`, `providerId`, `stageId`). **WaseetAI does not have our data**, so any endpoint that takes only an id answers about a project/provider it has never seen.

---

## 0. SECURITY — bearer token is public (release blocker)

The tenant token is printed in the integration guide PDF **and** in the publicly hosted test lab
(`https://waaseet-ai.web.app/app.js?v=17`, plain `"Authorization": "Bearer …"` literal).
It is the same token our backend uses.

Request:
1. Issue a new token and **revoke the old one immediately**.
2. Remove the literal from the hosted lab and from the guide; load it from user input in the lab.
3. Separate tokens per environment (dev / bank / prod) if possible.

---

## 1. WIRED (for reference — verified request/response)

| Endpoint | Our use | Verified response keys |
|---|---|---|
| `POST /v1/ai/project-description/stream` | description generation | SSE `generation.started` → `text.delta{chunk}` → `generation.completed` |
| `POST /v1/ai/text/enhance/stream` | refine an existing draft | same SSE events; request `{description}` |
| `POST /v1/ai/text/suggest/stream` | text suggestion | same SSE events; request `{title}` |
| `POST /v1/ai/milestones` | milestones | `{milestones:[{title,description,days,percentage,amount}]}` |
| `POST /v1/ai/project-analysis` | project analysis | `{clarityScore,feasibilityScore,marketFitRating,executiveSummary,strengths,gapsAndRisks}` |
| `POST /v1/ai/request-draft` | client request draft | `{suggestedTitle,suggestedDescription,suggestedSubSpecialties[],recommendedMinBudget,recommendedMaxBudget,suggestedDurationDays,complexityRating,personalizedNote,aiMatchScoreEstimate}` |
| `POST /v1/ai/profile/skills` | skills | `{suggestedSkills:[…]}` |
| `POST /v1/ai/profile/performance-summary` | public-profile metrics | 8 numeric fields, computed from the counts we send |
| `POST /v1/ai/proposals/suggest` | proposal polishing | see §2.9 (price audit unusable) |
| `POST /v1/ai/disputes/summary` | admin dispute summary | `{summary,clientPerspective,providerPerspective,recommendation}` (we discard `recommendation`) |
| `POST /v1/ai/assessments/stream` + `/assessments` + `/assessments/:id/submit` | assessments | see §3 |
| `POST /v1/ai/help/chat` | support assistant | see §4 |
| `POST /v1/ai/tts/synthesize` | speech | WAV in `data.audio.base64Audio` |

---

## 2. BLOCKED endpoints

### 2.1 `POST /v1/ai/matching/projects-for-provider` — constant sample data

Request A: `{"providerId":"prov-expert-01","limit":3}`
Request B: `{"providerId":"zzz-unknown-9","limit":3,"specialtyFilter":"تصميم جرافيك"}`

Both returned the **identical** response (172 ms, no model call):

```json
{"aiMatchingProjects":[
 {"projectId":"proj-verified-1","aiMatchScore":90,"matchReasons":["تطابق عالي مع الخبرات المعتمدة","سجل إنجاز ممتاز في نفس التخصص"],"generationSource":"GEMINI"},
 {"projectId":"proj-verified-2","aiMatchScore":88,"matchReasons":["…"],"generationSource":"GEMINI"},
 {"projectId":"proj-verified-3","aiMatchScore":86,"matchReasons":["…"],"generationSource":"GEMINI"}],
 "summary":{"aiRating":4.6}}
```

Problem: fixed ids and scores, labelled `GEMINI`, ignoring `providerId`, `limit` and `specialtyFilter`. Showing this would be fabricated matching.
Needed: accept candidates (our project summaries) in the request and rank those, returning scores/reasons for the ids we sent. Document the candidate schema and limits.

### 2.2 `POST /v1/ai/marketplace/recommendations` — constant sample data

Requests `{"query":"تصميم شعار"}` and `{"query":"برمجة تطبيقات"}` returned the identical 5 items:

```json
{"items":[{"id":"srv-1001","title":"تصميم واجهات مستخدم متكاملة بنظام Design System حديث","generationSource":"GEMINI"}, … "srv-1005"]}
```

Problem: ids/titles do not exist in our catalog; output ignores `query`.
Needed: accept our candidate services (`id,title,category,price…`) and return ranked ids from that list, or confirm this endpoint is only a demo.

### 2.3 `POST /v1/ai/project-fit` — cannot see the project

Request: `{"projectId":"zzz-unknown-7","providerSpecialty":"تصميم شعارات","providerRate":10,"currency":"USD"}` (extra `title`/`description` keys are stripped).
Response `matchSummary` (translated): *"the project name 'zzz-unknown-7' is vague and has no clear details… depends entirely on the assumption it needs creative design"*.
With `projectId":"proj-101"` it answered as if it knew a React project ("requirements focus on building interactive UIs") — invented.
Needed: fields for the project content (title, description, requirements, budget, deadline, skills) in the request.

### 2.4 `POST /v1/ai/project-health` — no project data, identical context

Requests `{"view":"client","projectId":"proj-101"}` and `{"view":"provider","projectId":"zzz-unknown-7"}` both return the same invented facts (*"single stage not completed, 7 days remaining"*): `{"confidence":65,"riskLevel":"Medium","riskLevelKey":"MEDIUM","healthRating":"Attention Needed","bullets":[…],"earlyDays":0,"matchPercentage":0}`.
Needed: request fields for stages, deadlines, delivery status, revision/dispute counts (we compute these) — and a documented meaning for `earlyDays`/`matchPercentage` (always 0 here). This feature handles sensitive data: please confirm it is routed to the paid/sensitive project.

### 2.5 `POST /v1/ai/delivery-review` — no delivery data

Request `{"view":"provider","projectId":"zzz-1","stageId":"zzz-s"}` → *"the inputs for scope and deliverables are generic default texts… no links or files attached"*.
Needed: request fields for stage requirements, delivery note and file metadata. Same sensitive-data routing question as §2.4.

### 2.6 `POST /v1/ai/proposals/enrich` — scores a proposal against an unknown project

Request `{"projectId":"zzz-unknown-7","title":"عرض","message":"خبرة","totalPrice":100000,"deliveryDays":1}` → `{"id":"prop-…","aiMatchScore":10,"aiQualityTag":"Average","aiPriceTag":"High","aiFeedback":{"summary":"…"}}`.
`aiMatchScore` / `aiPriceTag` claim a match/price judgement relative to a project the service has never seen.
Needed: project context fields (budget range, requirements) or a documented statement that these scores are text-only; plus a stable id contract (what is `id`?).

### 2.7 `POST /v1/ai/proposals/audit/stream` — no proposal content

Request `{"providerId":"prov-expert-01","projectId":"proj-101"}` (the only required fields) → SSE `ai_audit_progress` ×4 then `ai_audit_result{profileAudit[],triPartyComparison…}` that quotes *"offer message is very short ('عرض قياسي')"* — invented proposal text.
Needed: request fields for the proposal draft, provider profile summary and project summary; document the `ai_audit_result` schema (scores, enums).

### 2.8 `POST /v1/ai/profile/bio` — ignores the provider

Request `{"providerId":"prov-A"}` and `{"providerId":"prov-B-zzz"}` → both return a multi-option template with `[اكتب تخصصك هنا]` placeholders (`{"suggestedBio":"…"}`), no use of provider data.
Needed: fields for specialty, experience, skills, headline; and a single bounded bio (not a list of options) in `suggestedBio`.

### 2.9 `POST /v1/ai/proposals/suggest` — usable except the price audit

Works (we use title/message/advantages/quality). But `priceAudit` (`{"recommendedMin":1500,"recommendedMax":3500,…}`) is the same regardless of project budget, so we discard it.
Needed: project budget in the request if `priceAudit` is meant to be real.

### 2.10 `POST /v1/ai/portfolio-review` and `POST /v1/ai/accreditation-review` — no sample content

`portfolio-review` required field is only `providerSpecialtyId`; response said *"models are suitable for the programming specialty 'ps-1'"* — it invented the portfolio.
`accreditation-review` required field is only `title`; response judged a logo sample as "not a programming work" with no description/links given.
Needed: request schema for sample content (title, description, technologies, project/GitHub URLs, attachment metadata or text extracts) and the specialty name/category they should be judged against. Is image/file content supported? How should files be sent?

### 2.11 `POST /v1/ai/business-models/audit` and `/re-audit` — missing category field

Request `{"title":"باقة تصميم شعار","description":"تصميم شعار مع ثلاث مراجعات","pricing":{"amount":100,"currency":"USD"}}` (required: `title`, `description`, `pricing.amount`) →
`{"isApproved":false,"score":65,"summary":"rejected… wrong category: classified under 'software services' while it is 'design & graphics'","issues":[…]}`.
The service guessed a category because none can be sent, so it rejects valid services.
Needed: category/specialty field(s), the full response schema, what `isApproved` means for us (advisory only), and the `re-audit` item schema (`items[].…`).

### 2.12 `POST /v1/ai/onboarding-quizzes` — fixed generic quiz

`{}` returns a fixed 5-question platform-knowledge quiz (`attemptId: "onboard-…"`, options as plain strings, no answer ids). Our onboarding test is a per-specialty professional assessment, so we cannot use it as is.
Needed: confirm intent; if per-specialty, the request fields; document how to grade it (`/assessments/:id/submit` with `onboard-…` ids?).

### 2.13 Endpoints we need that do not appear in the matrix

- **Specialty evaluation by AI for a provider specialty** (work samples → scores) — we found no endpoint; is `portfolio-review` the intended one?
- **Deep project analysis for a provider** — is `project-fit` the intended endpoint?

---

## 3. Assessments — what we need confirmed (WIRED, with open questions)

Verified live:
`POST /v1/ai/assessments/stream` with `{"providerSpecialtyId":"ps-1","specialtyName":"تصميم الشعارات","questionCount":3,"timeLimitMinutes":15}` →
`event: question.streamed` ×3 `{"attemptId":"att-…","question":{"id":1,"textAr":"…","options":[{"id":"a","text":"…"},…]}}`, then
`event: assessment.ready {"attemptId":"att-…","totalQuestions":3,"timeLimitMinutes":15,"generationSource":"GEMINI"}`.
`POST /v1/ai/assessments/att-…/submit {"submittedAnswers":{"1":"a","2":"a","3":"a"},"timeSpentSeconds":40}` →
`{"attemptId":"att-…","score":33,"isPassed":false,"status":"COMPLETED","feedbackAr":"…","strengths":[…],"weaknesses":[…]}`.

Open questions:
1. **Pass threshold** behind `isPassed` (we saw 33 → false). Can we send our own threshold?
2. Is a **second submit** for the same `attemptId` rejected, idempotent, or re-graded? (We retry after our own transient failures.)
3. The "stream" delivered all questions in one burst (~3.8 s for 3 questions, all events at the same instant). Is incremental delivery planned?
4. Can questions be **personalised** (provider portfolio, sub-specialties, category) — which request fields?
5. Can the result include per-question correctness / `correctAnswers` and explanations (or must we not show them)?
6. `createAssessment` response types `questions[].id` as string in the guide but the stream sends numbers — which is canonical?
7. `generationSource` (we saw `"GEMINI"`): documented values and meaning.

---

## 4. Help assistant — knowledge base is empty for every question we tried

`POST /v1/ai/help/chat` (and `/help/stream`) with `{"question":"كيف يعمل الضمان في المنصة؟"}`, `"ما هي رسوم المنصة؟"`, `"ما هي شروط الدفع الآمن Escrow؟"`, `"escrow terms"` all answered:

```
event: help:answer_start   data: {"status":"started","citationsCount":0}
event: help:error          data: {"message":"لم يتم العثور على سياسة معتمدة للإجابة على هذا الاستفسار. يرجى مراجعة الدعم البشري.","human_support_fallback":true}
```

Needed: approved policy documents loaded (the guide's own example cites `docId: terms-escrow`), and the success-path event names confirmed (we infer `help:answer_chunk` / `help:citations` / `help:answer_complete`; the guide says `text.delta` / `citations` / `generation.completed`). Is `/help/stream` an alias of `/help/chat`?

---

## 5. Latency observations (synthetic data, single call each)

| Endpoint | Observed |
|---|---|
| `project-description/stream` | first chunk after ~14 s |
| `text/suggest/stream` | first chunk ~6.4 s, total ~10.7 s |
| `text/enhance/stream` | first chunk ~1.5 s, total ~5.5 s |
| `assessments/stream` (20 questions) | 10–17 s, all questions at once |
| `project-fit` | ~7 s · `profile/skills` ~1–8 s · `request-draft` ~4.8 s · `proposals/suggest` ~6–8 s |

Please share expected p95 so we can set client timeouts (currently 30 s REST / 45–90 s stream).

---

## 6. What we will do once a fix lands

For each endpoint above, the typed client method, adapter and tests are a small change — the only blocker is the contract/data access. Tell us when one is ready and we re-run the same probes (requests above) to verify before wiring.
