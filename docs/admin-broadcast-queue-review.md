# Broadcast pre-activation runbook / دليل ما قبل تفعيل عامل البث

Goal: when `ADMIN_BROADCAST_WORKER_ENABLED=true` is set, NO old message may be sent by accident. / الهدف: عند تفعيل العامل لا تُرسل رسالة قديمة بالخطأ.

## Why / لماذا
A job confirmed while the worker was ON and then left unfinished stays QUEUED/SENDING. Turning the worker on later would deliver that old message to real users. Three guards exist: (a) the **max-age guard** (a job older than `BROADCAST_MAX_QUEUE_AGE_HOURS`, default 24, invalid/0/negative values fall back to 24, is never claimed by the worker unless an admin re-approves it), (b) the **preflight check**, (c) **cancel**.

## queueState meanings / الحالات
| queueState | Arabic | Meaning |
|---|---|---|
| `WAITING_WORKER_DISABLED` | في الانتظار — العامل مقفول | flag OFF, job waits. Nothing is sent while the worker is off. |
| `WAITING_FOR_WORKER` | في الانتظار — بانتظار العامل | flag ON, next worker pass will take it. |
| `RUNNING` | يعمل الآن | live lease. Do not touch. |
| `STUCK_STOPPED_MID_RUN` | توقفت أثناء التنفيذ | progress made, lease expired, no heartbeat > 10 min. |
| `STUCK_NO_PROGRESS` | عالقة بلا تقدّم | QUEUED > 60 min, flag ON, nothing delivered. |
| `EXPIRED_NEEDS_REVIEW` | منتهية الصلاحية — تحتاج مراجعة | older than the max age and not re-approved. DERIVED from age (no database status), so the env limit applies live. The worker skips it. |

## Runbook / خطوات التنفيذ
1. **Identify old/stuck messages.** Queue screen (page "البث الجماعي" -> "طابور البث") and `GET /api/admin/broadcasts/queue`; `GET /queue/preflight` gives counts per state and blockers.
2. **Review or cancel everything not yet sent.**
   - `POST /:id/review` (button "تمت المراجعة") = "I saw it and accept it being sent". Audited (`BROADCAST_REVIEWED`).
   - `POST /:id/cancel {reason?}` = drop it. Only PENDING recipients become CANCELLED; recipients already SENT are never touched; nothing is sent; refused (409) while a worker holds a live lease; idempotent; audited (`BROADCAST_CANCELLED`).
   - `POST /:id/approve-send {reason}` (3-200 chars) = explicit re-approval of an EXPIRED job after review. Audited (`BROADCAST_REAPPROVED`, no body). Only then can a worker claim it.
3. **Confirm the preflight is green**: `canEnableSafely=true`, `blockers=[]`. Blockers: `EXPIRED_JOBS`, `STUCK_MID_RUN`, `STUCK_NO_PROGRESS`, `UNREVIEWED_JOBS`.
4. **Confirm what the max-age guard will skip.** `counts.EXPIRED_NEEDS_REVIEW` in preflight = jobs the worker will leave alone (it logs one line with the COUNT only when it skips). Anything you still want must be re-approved (step 2); the rest cancelled.
5. **Enable the flag in a controlled window**: set `ADMIN_BROADCAST_WORKER_ENABLED=true`, restart the backend.
6. **Verify the first job end to end with a harmless audience**: confirm a short test message to a small internal audience, watch the progress on the queue screen, check history counters (sent = audience) and that nobody got two (the database enforces one notification per broadcast and user).
7. **Rollback**: set the flag to anything but `true`, restart. New confirms and retries are refused, existing jobs wait (`WAITING_WORKER_DISABLED`), nothing is lost. If a job stopped mid-run, resume is safe and duplicate-free (notification + SENT mark are one transaction, unique indexes are the last guard); otherwise cancel it.

## NOT automated / ما لا يتم تلقائيًا
- Nothing cancels or approves jobs on its own; every decision is an explicit Super Admin action.
- The flag itself is changed by hand in the environment; the app never flips it.
- Preflight looks at the first 1000 queued jobs.
- Messages are not re-validated against current audience/draft: the audience was frozen at confirm time, so age and the explicit reason are the safeguards.
- No alert outside the broadcast page (banner + `queue/summary`).
