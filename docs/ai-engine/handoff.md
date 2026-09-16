# Waseet AI Engine Handoff

## Architecture Overview

The AI Engine centralizes structured backend AI work behind shared infrastructure:

- Central OpenAI provider: `openai-client.provider.ts` owns the shared OpenAI client.
- Model policy: `ai-model-policy.ts` resolves purpose, model, timeout, and retry policy from registered capability metadata.
- Prompt registry: prompt files register stable prompt IDs with explicit versions and locale support.
- Schema registry: schema files register strict Zod output contracts with explicit versions.
- Capability registry: capability files bind capability, operation, prompt version, schema version, model purpose, failure policy, temperature, and token limits.
- Structured executor: `structured-ai-execution.service.ts` renders prompts, calls the shared execution service, validates JSON with Zod, and records audit events.
- Normalized failures: `ai-execution.service.ts` converts missing config, provider errors, timeouts, rate limits, invalid JSON, and schema validation failures into normalized failed AI results where applicable. Timed-out OpenAI attempts receive an `AbortSignal` cancellation request before retrying, but abort does not guarantee provider-side processing or billing stops.
- Audit and observability: `AiExecutionAuditLog` records metadata such as execution ID, capability, operation, model, prompt/schema versions, latency, attempts, token usage, success/failure, error code, failure policy, redaction version, and bounded entity references.
- Privacy and redaction: generic audit intentionally does not persist raw prompts, raw model responses, or sensitive business payloads.
- Capability services: production services build sanitized, bounded context, call the structured executor, and keep AI advisory.

Capability modules live under `src/modules/ai-engine/capabilities/`. Calling services live in feature service files such as project review, matching, proposals, project operations, amendments, finance, disputes, and profile intelligence.

## Responsibility Boundary

AI may:

- analyze
- summarize
- rank
- recommend
- warn
- provide advisory structured intelligence

Backend or human authority owns:

- payments
- escrow
- VAT and tax truth
- contract state
- account state
- dispute resolution
- sensitive profile mutation
- identity verification
- final approvals and rejections

AI output must not become an authoritative business decision unless deterministic backend or human review separately makes that decision.

## Current Capability Inventory

| Operation | Purpose | Failure policy | Workflow | AI output persisted? | Authority boundary |
| --- | --- | --- | --- | --- | --- |
| `project_intelligence.suggest_milestones` | `standard_json` | `FAIL_CLOSED` | Explicit AI review milestone suggestion endpoint | No | Suggestions only; client/project creation remains controlled by existing services. |
| `project_intelligence.analyze_project_model` | `complex_reasoning` | `FAIL_CLOSED` | Explicit AI review analysis endpoint | No | Advisory project-model analysis only. |
| `project_intelligence.client_request_suggestions` | `complex_reasoning` | `FAIL_CLOSED` | Explicit client request AI suggestion endpoint | No | Produces suggestions; request creation remains existing backend behavior. |
| `matching.rank_provider_project_matches` | `standard_json` | `OPTIONAL_AI` | Provider/project matching enrichment | No | Ranking is advisory; no project assignment or acceptance decision. |
| `proposals.proposal_feedback` | `standard_json` | `FAIL_CLOSED` | Explicit proposal AI suggestion endpoint | No | Proposal text feedback only. |
| `proposals.proposal_submission_evaluation` | `standard_json` | `OPTIONAL_AI` | Embedded proposal submission enrichment | Yes, only validated optional fields on success | Proposal creation proceeds without fabricated AI values if AI fails. |
| `project_operations.project_health_analysis` | `standard_json` | `OPTIONAL_AI` | Embedded active project workspace health insight | No | Deterministic project facts remain authoritative; AI only interprets risk and next action. |
| `amendments.amendment_impact_analysis` | `complex_reasoning` | `FAIL_CLOSED` | Explicit project amendment AI analysis endpoint | No | Read/analyze only; no amendment, contract, escrow, deadline, or money mutation. |
| `finance.invoice_consistency_analysis` | `complex_reasoning` | `FAIL_CLOSED` | Explicit client invoice analysis endpoint | No | Advisory invoice consistency only; payment and invoice authority remains deterministic. |
| `finance.financial_report_insights` | `complex_reasoning` | `FAIL_CLOSED` | Explicit finance dashboard insight endpoint | No | Insight only; no wallet, escrow, or tax mutation. |
| `disputes.dispute_case_analysis` | `complex_reasoning` | `FAIL_CLOSED` | Explicit admin dispute analysis endpoint | No | Admin remains authoritative; AI cannot resolve disputes or move funds. |
| `profile_intelligence.sensitive_change_review` | `standard_json` | `OPTIONAL_AI` | Embedded provider/marketer sensitive-change human-review enrichment | Yes, advisory labels only when validated | Human admin remains authoritative; AI cannot approve, reject, apply, verify identity, suspend, or mutate profile fields. |

Only the operations above are registered Day 1 through Day 10. Do not document or call unregistered operations as production capabilities.

## Post-Day-10 Guards

- Proposal AI suggestions require authentication, active-user status, provider-like account type, and project-level access before project context is loaded or AI executes.
- Project details and project summaries require authentication, active-user status, and project-level access before full summary data is fetched.
- Client request AI suggestions require authentication and active-user status before the AI limiter and controller execute.
- Seven explicit AI endpoints use the existing `aiLimiter`: client request suggestions, proposal suggestions, amendment analysis, invoice analysis, finance dashboard insights, provider matching, and admin dispute analysis.
- `aiLimiter` remains IP-based and in-memory. Capability-specific tiers are not enforced, and embedded AI workflows are not individually rate-limited.
- Provider/project matching keeps the `OPTIONAL_AI` empty-result behavior for AI execution failures, but database, registry, programming, and unexpected runtime failures propagate instead of being converted into empty results.

## Adding A Capability Safely

1. Define the capability and operation names.
2. Create a versioned prompt file with provider-neutral prompt inputs.
3. Create a strict versioned Zod schema for the expected output.
4. Register the capability with exact prompt ID/version and schema ID/version.
5. Use `structuredAiExecutionService.execute(...)`; do not create a local OpenAI client.
6. Build a sanitized, bounded context object for model input.
7. Choose an explicit failure policy.
8. Add generic audit refs with entity IDs only, separate from model input.
9. Keep AI advisory and outside deterministic or human authority.
10. Add an evaluation fixture and safety assertions.
11. Run static verification before review.

## Prompt And Schema Versioning

- Prompt IDs stay stable for the same logical operation.
- Prompt versions must be bumped when prompt text or model-visible input semantics change.
- Schema versions must be bumped when the output contract changes.
- Capability registrations must always reference exact prompt and schema versions.
- Do not implement implicit latest-version lookup for production capabilities.

The Day 10 project-health privacy cleanup is an example: the prompt version changed because the serialized input shape changed, while the schema version stayed the same because the output contract did not change.

## Failure Policies

`FAIL_CLOSED`: the AI operation is part of an explicit AI endpoint or required AI result. Provider/config/validation failure should surface as a failed AI operation, with no fake success.

`OPTIONAL_AI`: the business workflow can proceed without AI. Normal AI failures return no enrichment, and services must not fabricate AI output.

`MANUAL_REVIEW`: reserved for workflows where AI failure or concern should route to human review. Do not assume automatic approval.

`STATIC_NON_AI_FALLBACK`: a deterministic fallback is allowed only when explicitly labeled as non-AI. It must not imitate model output.

## Privacy Rules

- Minimize model-visible context.
- Do not send secrets, raw PII, payment credentials, identity documents, chat history, dispute evidence, or uploaded file contents unless a reviewed operation strictly requires it.
- Prefer deterministic derived signals over raw sensitive values.
- Keep audit refs separate from model input.
- Generic AI audit must not store raw prompts, raw responses, or sensitive business payloads.
- Bound all user or database text sent to the model.
- Do not hash, mask, alias, or shorten unnecessary identifiers for model input; omit them instead.

Day 10 removed `project.id` and `contract.id` from `project_operations.project_health_analysis` model input while retaining IDs only for generic audit refs.

## Locale Behavior

- Registered prompts currently support Arabic locale.
- Current callers pass `locale: 'ar'`.
- English or mixed-language business text may appear inside user-provided fields.
- Structured enum values are language-neutral and must remain stable regardless of input language.
- Full English output localization is deferred and should not be claimed until prompt locale support and tests are added.

## Configuration

The AI Engine verifies `OPENAI_API_KEY` through `ai-engine.config.ts`.

Dummy values such as `dummy_key`, `dummy_key_for_build`, `replace_me`, and placeholder keys are treated as unavailable. When unavailable, behavior depends on the registered failure policy.

Model selection is centralized through `AI_ENGINE_MODEL_CATALOG`; new feature code must not hardcode model names.

## Safe Verification Commands

On Windows, use:

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
git diff --check
git status --short
```

Do not use `npm start` for verification. The `prestart` script runs Prisma generate and Prisma migrate deploy before starting the app.

## Prohibited Patterns

- Local `new OpenAI()` in new feature code.
- Hardcoded model names outside central policy.
- Local retry or timeout logic for model calls.
- Arbitrary JSON repair, brace extraction, or defaulting invalid model output.
- `Math.random()` or static text presented as AI confidence or AI recommendation.
- AI-driven payment, escrow, tax, contract, dispute, account, identity, or profile mutation authority.
- Raw sensitive payloads in generic audit metadata.
- Raw provider responses in public API results.
