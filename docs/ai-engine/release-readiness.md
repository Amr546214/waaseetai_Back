# Waseet AI Engine Release Readiness

## Must Pass Before Handoff

- TypeScript compilation succeeds:

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
```

- Intended Git state is clean or contains only approved documentation changes.
- `git diff --check` passes.
- No unintended Prisma schema or migration changes exist.
- Capability, prompt, and schema registrations are consistent.
- Prompt and schema versions are explicit.
- Privacy review is complete.
- Authority-boundary review is complete.
- Failure policies are documented.
- Generic audit privacy rules are documented.
- Technical debt is accepted and recorded.

## Should Pass

- Evaluation matrix reviewed.
- Arabic, English, and mixed-input coverage documented.
- Swagger gaps documented.
- Optional live-provider smoke plan documented for operator-controlled environments.

## Known Deferred Limitations

- Full localization beyond Arabic registered prompts.
- Legacy direct OpenAI migrations.
- Assistant, TTS, and streaming abstractions.
- Proposal audit socket migration.
- Assessment, accreditation, and specialty AI migration.
- Profile improvement, bio generation, and public provider `aiMetrics` migration.
- Marketplace AI migration.
- Full automated evaluation/test framework.
- Capability-specific, distributed, per-user, and embedded-workflow AI rate limiting.

## Deployment Cautions

- `OPENAI_API_KEY` must be configured with a real key for provider calls.
- Placeholder or dummy API keys are treated as unavailable by the AI Engine.
- The Day 3 AI audit migration exists and must be deployed only through the normal operator deployment process.
- Do not casually run migrations during local verification.
- Do not use `npm start` as a verification command. Its `prestart` script runs Prisma generate and Prisma migrate deploy.
- AI-unavailable behavior depends on each operation's registered failure policy.
- `OPTIONAL_AI` workflows must not fabricate model output when AI fails.
- `FAIL_CLOSED` endpoints should surface standardized AI failure behavior and should not return fake analysis.
- Generic audit should contain metadata and entity references only, not prompts, model responses, or sensitive payload.
- Seven explicit AI endpoints use the existing `aiLimiter`, but the limiter is IP-based and in-memory. Capability-specific tiers are not enforced, and embedded AI workflows are not individually rate-limited.
- Timed-out OpenAI attempts receive an AbortSignal cancellation request before retrying. This is best-effort and does not guarantee provider-side processing or billing stops.
- Automated integration tests and live-provider evaluations have not been executed as part of this documentation package.
- The AI audit Prisma migration has not been deployed by these verification steps.

## Final Safe Windows Commands

```powershell
.\node_modules\.bin\tsc.cmd --noEmit
git diff --check
git status --short
git diff --stat
```

Do not include deployment or migration commands as verification steps.

## Release Gate

| Gate | Status owner | Notes |
| --- | --- | --- |
| TypeScript compile | Engineering | Required before handoff. |
| Static diff check | Engineering | Required before handoff. |
| Prisma diff review | Engineering/operator | Must confirm no unintended schema or migration changes. |
| Capability registry review | Engineering | Confirm only intended registered operations exist. |
| Prompt/schema version review | Engineering | Confirm exact versions and no implicit latest lookup. |
| Privacy review | Engineering/security | Confirm minimized model context and audit refs. |
| Authority-boundary review | Engineering/product | Confirm AI remains advisory for money, disputes, contracts, account, and profile mutation. |
| Failure policy review | Engineering/product | Confirm optional vs fail-closed behavior per operation. |
| Documentation review | Engineering | Confirm handoff, evaluation, technical debt, and readiness docs are current. |

## Swagger Status

Swagger is not changed by this package. Auto-discovery exists, and some older AI endpoints have request-body examples. Several newer Day 6 through Day 9 AI workflows have incomplete request/response documentation and should be treated as documentation debt, not a runtime release blocker.
