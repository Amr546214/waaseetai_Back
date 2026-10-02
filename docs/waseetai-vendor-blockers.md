# WaseetAI — blocking issues per endpoint

Prepared 2026-10-02 (updated after a second round of probes) from live calls against the Cloud Run
service using **synthetic data only** (no real users, projects or disputes). No credentials appear here;
every request was sent with `Authorization: Bearer <redacted>`.

## How we discovered what each endpoint accepts

- Unknown top-level keys are silently stripped, so "trying" a field tells us nothing by itself.
- Required fields come from `VALIDATION_ERROR` details.
- **Optional schema keys**: we send candidate keys with a deliberately wrong type (`{"__probe":true}`); a key that
  is in the schema is rejected with a validation error that names its path and expected type, a stripped key is
  silently ignored. This costs no model call. The table below lists what that found ("accepted keys").
  Keys that are not in the schema can never carry our data, whatever we send.
- Where a key is accepted we then checked **behaviour**: does the answer change with the input, and does it
  stay inside what we sent? Both are required before we wire anything.

Status legend: **WIRED** = integrated · **PARTIAL** = integrated with some fields deliberately unused ·
**BLOCKED** = cannot be integrated honestly with the current contract.

---

## 0. SECURITY — bearer token is public (release blocker)

The tenant token is printed in the integration guide PDF **and** in the publicly hosted test lab
(`https://waaseet-ai.web.app/app.js?v=17`, plain `"Authorization": "Bearer …"` literal). It is the same token
our backend uses.

Needed from the service owner:
1. Issue a new token and **revoke the old one immediately**.
2. Remove the literal from the hosted lab and from the guide (read it from user input in the lab).
3. Separate tokens per environment (dev / bank / prod).

---

## 1. WIRED / PARTIAL

| Endpoint | Status | Notes |
|---|---|---|
| `project-description/stream`, `text/enhance/stream` `{description}`, `text/suggest/stream` `{title}` | WIRED | SSE `text.delta{chunk}` → `generation.completed` |
| `milestones`, `project-analysis`, `request-draft`, `tts/synthesize` | WIRED | |
| `profile/skills` `{providerId, specialtyName, existingSkills[]}` | WIRED | output follows `specialtyName`; `existingSkills` honoured |
| `profile/performance-summary` | WIRED | 8 numeric fields computed from the counts we send |
| `proposals/suggest` | PARTIAL | `priceAudit` ignored (not tied to the real project budget) |
| `proposals/enrich` `{projectId,title,message,totalPrice,deliveryDays,milestones[]}` | PARTIAL | verdict follows the proposal's own plan/price/days (92 strong, 88 strong+cheap, 10 empty); because the service cannot see the project, `aiMatchScore` is a **proposal-quality** score and `aiPriceTag` is not relative to the real budget → we use quality tag + summary and combine with our own budget factor |
| `business-models/audit` `{title,description,category,pricing.amount}` | WIRED (advisory) | with the right `category` the verdict follows the data (88 approved; wrong category 75 flagged; vague listing 10). Without `category` it wrongly rejects valid listings |
| `disputes/summary` | WIRED | we discard `recommendation` |
| `assessments/stream`, `assessments`, `assessments/:id/submit` | WIRED | open questions in §3. Also drives the provider **setup test** (15 questions, graded once at the end; no per-question correctness, so the UI shows the score only) |
| `help/chat` | WIRED (transport) | knowledge base empty — §4 |

---

## 2. BLOCKED endpoints — exact change required in WaseetAI

For each endpoint: what we found, and **the change we need**. "Acceptance" is the check we will re-run.

### 2.1 `POST /v1/ai/matching/projects-for-provider` — constant sample data
Accepted keys: `providerId` (required), `limit`, `specialtyFilter`. Nothing else.
Request A `{"providerId":"prov-expert-01","limit":3}` and request B `{"providerId":"zzz-unknown-9","limit":3,"specialtyFilter":"تصميم جرافيك"}` return the **identical** payload in 172 ms (no model call):
```json
{"aiMatchingProjects":[{"projectId":"proj-verified-1","aiMatchScore":90,"matchReasons":["تطابق عالي مع الخبرات المعتمدة","سجل إنجاز ممتاز في نفس التخصص"],"generationSource":"GEMINI"}, …"proj-verified-3"],"summary":{"aiRating":4.6}}
```
**Change needed:** accept the candidate set and the provider profile and rank *those*:
```json
{"providerId":"u-123","provider":{"specialties":["تصميم الشعارات"],"skills":["Illustrator"],"yearsOfExperience":6,"level":"EXPERT","hourlyRate":25},
 "candidates":[{"projectId":"<our uuid>","title":"…","description":"…","requirements":["…"],"budgetMin":300,"budgetMax":900,"deliveryDays":10,"category":"التصميم"}],
 "limit":3}
```
Response must contain only ids from `candidates`, with `aiMatchScore` (0–100) and real `matchReasons` derived from the inputs; `generationSource` must say what actually produced it.
**Acceptance:** two different candidate sets/providers give different rankings; every returned `projectId` is one we sent.

**Re-verified 2026-10-02 (synthetic data, from the dev container).** Three calls: (M1) a designer provider with two of our candidate projects (`cand-A` logo design, `cand-B` Node.js API), (M2) a developer provider with the *same* candidates, (M3) `providerId` only. All three returned HTTP 200 with the identical payload `proj-verified-1:90, proj-verified-2:88` — ids that are not ours and scores that did not change with provider, specialties, skills or candidates. The extra `provider`/`candidates` keys are silently stripped, so today the endpoint cannot rank our projects at all.
**Platform status:** matching stays on the deterministic rule engine (`generationSource: 'DETERMINISTIC'`, `aiMatchScore: null`) and the UI labels it "قواعد ثابتة (دون AI)". Nothing is wired to this endpoint, and no AI percentage is shown. We will wire it only after the acceptance check below passes.

### 2.2 `POST /v1/ai/marketplace/recommendations` — constant sample data
Accepted keys: `query` (required), `limit`, `category`. Requests `{"query":"تصميم شعار"}` and `{"query":"برمجة تطبيقات"}` return the same five items (`srv-1001`…`srv-1005`, labelled `GEMINI`).
**Change needed:** accept `candidates:[{id,title,category,price,rating,deliveryDays,description}]` (our catalog slice) and return a ranking of those ids with a reason; or document the endpoint as demo-only.
**Acceptance:** results change with `query`; ids are a subset of what we sent.

### 2.3 `POST /v1/ai/project-fit` — cannot see the project
Accepted keys: `projectId` (required), `currency`, `providerSpecialty`, `providerRate`. No project content can be sent.
`{"projectId":"zzz-unknown-7","providerSpecialty":"تصميم شعارات","providerRate":10}` → *"the project name 'zzz-unknown-7' is vague… depends entirely on the assumption it needs creative design"*; with `proj-101` it invents *"requirements focus on interactive UIs"*.
**Change needed:** a `project` object: `{title, description, requirements[], budgetMin, budgetMax, deliveryDays, skills[], category}` (+ optional provider `skills[]`, `yearsOfExperience`, `level`).
**Acceptance:** the summary cites facts present in what we sent and nothing else; changing `description` changes the verdict.

### 2.4 `POST /v1/ai/project-health` — invents the stages
Accepted keys: `view` (client|provider), `projectId` (required), `title`, `daysRemaining`.
We can send a real title and days remaining, and the verdict does move with them (`daysRemaining:2` → High/Critical; `60` → Low/Good) — **but the bullets also assert facts we did not send**: *"the single stage is not completed (0%)"*, *"المرحلة الوحيدة"*. With `earlyDays:-5` / `matchPercentage:0|100` derived from an assumed duration.
**Change needed:** accept the facts it reasons about: `stages:[{order,title,status,days,percentage}]`, `totalDays`, `daysElapsed`, `revisionCount`, `disputeCount`, `lastActivityDays`, and compute `earlyDays`/`matchPercentage` from them (document both fields). Never state stage/progress facts that were not provided.
**Acceptance:** with 4 stages of which 2 approved, the output says so; with no stage data it says "no stage data" instead of inventing one. Please also confirm this endpoint is routed to the sensitive/paid project.

### 2.5 `POST /v1/ai/delivery-review` — no delivery data
Accepted keys: `view`, `projectId`, `stageId` only. Output: *"scope and deliverables are generic default texts… no links or files attached"*.
**Change needed:** `stage:{title,description,requirements[]}`, `delivery:{note,files:[{name,type,sizeBytes,url?}],submittedAt,revisionNumber}`, `project:{title,description}`. State clearly whether file *contents* are read (today the output claims no content).
**Acceptance:** the review quotes the stage requirement and the delivery note we sent; unmet requirements are listed from our `requirements[]`. Same sensitive-routing question as §2.4.

### 2.6 `POST /v1/ai/proposals/audit/stream` — no project/provider data
Accepted keys: `providerId`, `projectId` (required), `proposalMessage`. The `ai_audit_result` says *"offer message is very short ('عرض قياسي')"* and describes a provider profile it was never given.
**Change needed:** accept `proposal:{title,message,totalPrice,deliveryDays,advantages[],milestones[]}`, `provider:{specialties[],skills[],yearsOfExperience,level,rating,completedProjects}`, `project:{title,description,requirements[],budgetMin,budgetMax,deliveryDays}`; document `ai_audit_result` (field names, score ranges, enums) and the progress events.
**Acceptance:** each statement in `profileAudit` / `triPartyComparison` can be traced to a field we sent.

### 2.7 `POST /v1/ai/profile/bio` — three options, but no stable format
Accepted keys: `providerId` (required), `currentBio` (string), `specialties` (array), `yearsOfExperience` (number).
**The input side works**: across 6 live samples (6 different specialties / years) every answer used the specialty and the exact years and contained no placeholders, and always offered **3 options**.
**The output cannot be split safely.** Layout measured on the same 6 samples:

| sample | option headings | body format |
|---|---|---|
| 0 | `**الخيار الأول (…):**` | inline `"…"` quotes |
| 1 | `### الخيار الأول: …` + `---` separators | inline quotes |
| 2 | `**الخيار الأول: …**` | `> "…"` blockquote |
| 3 | `### الخيار …` + `---` | inline quotes |
| 4 | `### الخيار …` | bare paragraphs with a bold title line, no quotes |
| 5 | `### الخيار …` | inline quotes |

Also: all 6 answers append a "tips" section (`**نصائح إضافية…**` or a bare paragraph) with no consistent marker; 4 of 6 name a competitor platform (`على منصة "مستقل"` in the intro and/or tips); and option text sometimes claims unprovable achievements ("نجحت في تنفيذ العديد من المشاريع").
We will not parse this by guesswork.
**Change needed:** return **one** plain-text bio (≤ a `maxLength` we send, e.g. 500) in `suggestedBio` with no headings, intro, tips or platform names; or a structured `suggestions:[string]` of exactly the requested count. Never mention other platforms; do not invent achievements, client counts or projects.
**Acceptance:** 10 consecutive calls with different inputs return a single paragraph ≤ `maxLength`, contain only facts present in the input (years, specialties, current bio), and no markdown.

### 2.8 `POST /v1/ai/portfolio-review` — no sample content
Accepted keys: `providerSpecialtyId` only. Response invents the portfolio (*"samples fit the programming specialty 'ps-1'"*).
**Change needed:** `specialtyName` and `samples:[{title,description,technologies[],projectUrl,githubUrl,attachments:[{name,type}]}]`.
**Acceptance:** feedback references the samples we sent by title.

### 2.9 `POST /v1/ai/accreditation-review` — grades a repository it cannot open
Accepted keys: `title` (required), `githubUrl`, `technologiesUsed[]`. (`description` and `projectUrl` are **not** in the schema.)
With `{"title":"متجر إلكتروني بـReact","technologiesUsed":["React","Node.js","PostgreSQL"],"githubUrl":"https://github.com/example-test/shop"}` the result was `AI_VERIFIED`, score **88**, praising *"a clean decoupled architecture between React and Node/PostgreSQL"* — the repository does not exist. Without those fields: `REJECTED`, 15.
**Change needed:** either actually fetch/inspect the URL and say what was inspected, or return an explicit `inspected:false` / `basis:"declared-fields-only"` and never grade code quality; accept `description` and `projectUrl`; accept attachment metadata/text extracts.
**Acceptance:** an invalid/unreachable URL produces `inspected:false` and no code-quality claims.

### 2.10 `POST /v1/ai/proposals/suggest` — price audit not tied to the project
Works except `priceAudit` (identical range for any project). **Change needed:** accept `project:{budgetMin,budgetMax,title,requirements[]}`; compute `priceAudit` from it.

### 2.11 `POST /v1/ai/onboarding-quizzes` — not needed any more
`{}` returns a fixed 5-question platform-knowledge quiz. We now run the provider setup test through `assessments/stream` + `submit` (per-specialty), so this endpoint is only relevant if you want a separate *platform* onboarding quiz; if so, please document its option ids and grading.

### 2.11b Not blocked by the service but needing a product decision on our side — avatar
`POST /v1/ai/avatar/chat {"message"}` → `{text, audio:{mimeType:"audio/mp3", base64Audio}}` is documented and our client has `avatarChat`. We have no avatar chat screen or persona (the old `ai_chat` gateway was removed on purpose); the in-app assistant ("Bebo") is deferred to a separate track (§4). Needs: where it appears, persona/tone, cost limits.

### 2.11c Description AI pre-check (title / specialty consistency) — needs a new endpoint
No endpoint validates a project title against the chosen specialty. We keep only our deterministic check. **Change needed:** e.g. `POST /v1/ai/request-title-check {title, specialty, subSpecialties[]}` → `{isMeaningful, isAligned, reasonAr}` (or document an existing endpoint that does this).

### 2.12 Endpoints we need that do not appear in the matrix
- AI evaluation of a provider's specialty from work samples (`portfolio-review` may be the intended one).
- Deep per-project analysis for a provider (`project-fit` may be the intended one).

---

## 3. Assessments — open questions (WIRED)

Verified: `POST /v1/ai/assessments/stream` `{"providerSpecialtyId","specialtyName","questionCount","timeLimitMinutes"}` →
`question.streamed` ×N `{attemptId,question:{id,textAr,options:[{id,text}]}}` then `assessment.ready {attemptId,totalQuestions,timeLimitMinutes,generationSource}`;
`POST /v1/ai/assessments/:id/submit {"submittedAnswers":{"1":"a",…},"timeSpentSeconds":40}` → `{score,isPassed,status,feedbackAr,strengths[],weaknesses[]}`.

1. The **pass threshold** behind `isPassed` (33 → false). Can we send our own?
2. Is a **second submit** for the same `attemptId` rejected, idempotent, or re-graded?
3. The "stream" delivers all questions at the same instant after generation (~3.8 s for 3). Is incremental delivery planned?
4. Can questions be **personalised** (portfolio, sub-specialties, category) — which fields?
5. Can the result include per-question correctness / `correctAnswers`? (We show nothing we did not receive.)
6. `questions[].id`: string in the guide, number in the stream.
7. `generationSource` (we saw `"GEMINI"`): documented values and meaning.

---

## 4. Help assistant — knowledge base empty (DEFERRED: separate track, not reviewed or tested in this round)

`help/chat` and `help/stream` with `"كيف يعمل الضمان في المنصة؟"`, `"ما هي رسوم المنصة؟"`, `"ما هي شروط الدفع الآمن Escrow؟"`, `"escrow terms"` all return
`event: help:answer_start {"status":"started","citationsCount":0}` then
`event: help:error {"message":"لم يتم العثور على سياسة معتمدة…","human_support_fallback":true}`.
Needed: approved policy documents (the guide cites `docId: terms-escrow`), the confirmed success-path event names (we infer `help:answer_chunk` / `help:citations` / `help:answer_complete`; the guide says `text.delta` / `citations` / `generation.completed`), and whether `/help/stream` is an alias of `/help/chat`.

---

## 5. Latency observations (synthetic data)

| Endpoint | Observed |
|---|---|
| `project-description/stream` | first chunk ~14 s |
| `text/suggest/stream` | first chunk ~6.4 s, total ~10.7 s |
| `text/enhance/stream` | first chunk ~1.5 s, total ~5.5 s |
| `assessments/stream` (20 questions) | 10–17 s, all questions at once |
| `project-fit` ~7 s · `profile/skills` 1–8 s · `request-draft` ~4.8 s · `proposals/suggest` 6–8 s · `proposals/enrich` 1.4–3 s | |

Please share expected p95 so we can set client timeouts (now 30 s REST / 45–90 s stream).

---

## 6. When a change lands

Tell us which endpoint; we re-run the probes above (including the "acceptance" check) before wiring. Typed
client methods, adapters and tests for each are a small change — the blocker is the contract/data access.
