# Broadcast queue review and pre-activation checklist / مراجعة طابور البث وخطوات ما قبل التفعيل

## Why stale queued jobs are dangerous / لماذا الطابور القديم خطر
A broadcast confirmed while `ADMIN_BROADCAST_WORKER_ENABLED` is not `true` is refused (nothing queued). But a job confirmed while the worker was ON and later left unfinished (worker stopped, flag turned off) stays QUEUED/SENDING. The moment the worker is turned on again it would deliver that old message to real users. Always review and cancel stale jobs BEFORE turning the flag on.

## 1. Review the queue / راجع الطابور
Super Admin only: page "البث الجماعي" -> tab "الطابور" (API: `GET /api/admin/broadcasts/queue`, cheap check: `GET /api/admin/broadcasts/queue/summary`). Each job shows sender, category, audience, counters (audience / sent / failed / pending), age and last progress. No message bodies are listed.

## 2. queueState meanings / معاني الحالات
| queueState | Arabic | Meaning |
|---|---|---|
| `WAITING_WORKER_DISABLED` | في الانتظار — العامل مقفول | QUEUED (or resumable) and the worker flag is OFF. Normal while the flag is off; it will be delivered the moment the flag is turned on. |
| `WAITING_FOR_WORKER` | في الانتظار — بانتظار العامل | Flag ON, waiting for the next worker pass (seconds). |
| `RUNNING` | يعمل الآن | SENDING with a live lease. Do not touch. |
| `STUCK_STOPPED_MID_RUN` | توقفت أثناء التنفيذ | Some recipients already handled, lease expired and no heartbeat for more than 10 minutes. Reported even with the flag OFF. |
| `STUCK_NO_PROGRESS` | عالقة بلا تقدّم | QUEUED for more than 60 minutes with the flag ON and nothing delivered. |
Thresholds are the constants `stuckMidRunMs` (10 min) and `stuckNoProgressMs` (60 min) in `admin-broadcast.service.ts`.

## 3. Cancel stale jobs / إلغاء القديم
Per job: "إلغاء" with an optional reason (<= 200 chars), or `POST /api/admin/broadcasts/:id/cancel {"reason": "..."}`. Allowed for QUEUED jobs and for SENDING jobs whose lease expired. Refused (409 `BROADCAST_RUNNING`) while a worker holds a live lease; refused (409 `BROADCAST_NOT_CANCELLABLE`) for finished jobs. It marks the job and its still-PENDING recipients CANCELLED, never touches recipients already SENT, never sends anything, is idempotent (second call = same result) and writes an audit row `BROADCAST_CANCELLED` (no message body). A cancelled job is never claimed by any worker.

## 4. Before setting the flag / قبل التفعيل
1. Open the queue: it must be empty, or contain only jobs you deliberately accept (their message and audience are still wanted).
2. Cancel everything else (step 3). `queue/summary` must show `waitingDisabled=0`, `stuckMidRun=0`, `stuckNoProgress=0` except accepted jobs.
3. Only then set `ADMIN_BROADCAST_WORKER_ENABLED=true` and restart the backend.

## 5. After enabling / بعد التفعيل
`queue/summary` shows `workerEnabled=true`; accepted jobs move to RUNNING then leave the queue (history shows COMPLETED/PARTIAL). Check history counters: sent = audience, no recipient twice (the database enforces one notification per broadcast and user).

## 6. A job stuck mid-run / مهمة توقفت أثناء التنفيذ
Resume is safe: with the flag ON the next worker pass takes over an expired lease and continues only recipients still PENDING; recipients already SENT are never notified again (notification + SENT mark are one transaction, and unique indexes are the last guard). If the message is no longer wanted, cancel it instead (SENT recipients stay SENT).

## 7. Rollback / التراجع
Set the flag back to anything but `true` and restart. New confirms and retries are refused, existing jobs simply wait (state `WAITING_WORKER_DISABLED`), nothing is lost, and they can be cancelled from the queue screen.
