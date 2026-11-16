# WACRM durable WhatsApp broadcast worker (TEST rollout)

## Operating status

- Implemented on `refactor/service-platform-v2`; **TEST-only automatic execution**.
- Code/CI verification does not constitute live Meta/OpenWA acceptance or a production GO.
- The original Meta Cloud API remains the official/default transport. OpenWA is an opt-in linked-device transport; it does not own CRM, templates, policy, agents, or delivery state.
- Never enable a Production schedule without OW-12 live matrix, OW-13 bounded pilot, OW-14 decision and security review (including NOTE-001).

## Design and ownership

```text
Dashboard wizard / Public API / Resume button
  -> complete tenant-scoped broadcast + recipients
  -> enqueue_broadcast_delivery_job (service-only SQL)
  -> broadcast_delivery_jobs (durable lease / retryable work pointer)
  -> dedicated protected TEST worker tick
  -> one pending recipient (frozen provider, connection, E.164 identity)
  -> guarded provider-neutral WACRM transport
     |-> Meta Cloud API (approved templates / media headers)
     └── OpenWA (plain-text business copy + pilot guardrails)
  -> native provider_message_id + recipient ACK lifecycle in WACRM
```

### Guarantees and limitations

1. Job ownership is claimed with PostgreSQL `FOR UPDATE SKIP LOCKED` and a five-minute lease token. Settlement compares the exact token; only the owner can finish.
2. Provider attempts are **one per recipient reservation**, not an exactly-once network delivery guarantee. The `pending -> sending` conditional write happens before dispatch; stale `sending` transitions to `requires_reconciliation`, never back to `pending`.
3. A campaign is frozen to one account/provider/connection. Enqueue validates every recipient row. Its actual destination number is snapshotted once, so editing the CRM contact cannot redirect a queued send.
4. One recipient is processed per tick; next attempt is deferred 15 seconds for Meta or 30 seconds for OpenWA. This is a safe TEST throughput bound, *not* a production throughput SLA.
5. Unknown outcomes, token loss, missing provider configuration, and invalid plans pause the job for human review. Proven OpenWA pre-dispatch denials are the only `failed` category that can be intentionally requeued by the **Retry failed** action.
6. The worker cannot be invoked by browser users or public API keys; its endpoint requires `CRON_SECRET` and the pinned TEST project URL. Queue tables and RPCs are service-role only; a separate authorized read-only API projects status to the dashboard.
7. The legacy `/api/whatsapp/broadcast` batch-send route now fails closed with HTTP 410. Existing clients must use the durable enqueue endpoint, not bypass the queue.
8. New campaigns are drafted first; partial audience persistence never triggers a send. After all recipient rows are stored, the caller enqueues exactly one durable job. A process interruption **before enqueue** leaves a draft needing operator resume.

## TEST development operation

- Run the app with the existing `npm run dev` wrapper and `NEXT_PUBLIC_SUPABASE_URL` set to the pinned TEST project. Do not run production API credentials against TEST.
- `WACRM_DEV_BROADCAST_WORKER=on` (default on pinned TEST) processes queued campaigns automatically while the process is running. Set `WACRM_DEV_BROADCAST_WORKER=off` in `.env.local` and restart to disable. This does **not** disable the Agent Task worker; its independent switch is `WACRM_DEV_AGENT_TASK_WORKER`.
- The internal endpoint is `POST /api/internal/whatsapp-broadcast-worker`, protected by `Authorization: Bearer $CRON_SECRET`. Never expose the secret in client or logs.
- A worker crash is safe: unfinished queue jobs remain leased until expiry, then are reclaimed. Previously reserved recipients are quarantined for reconciliation; untouched pending recipients remain pending.
- An operator can view queue status and paused reason from each campaign's details page. Normal resume handles untouched pending recipients; retry failed accepts **only** verified pre-dispatch denials. Never use either to bypass an unsettled recipient.
- The legacy in-request / `after()` fan-out path is retired; do not reactivate it to solve a stalled campaign.

### Read-only SQL diagnostics on TEST

```sql
SELECT j.account_id, j.broadcast_id, j.state, j.attempt_count,
       j.next_attempt_at, j.lease_until, j.paused_reason
FROM public.broadcast_delivery_jobs j
ORDER BY j.created_at DESC
LIMIT 25;

SELECT r.broadcast_id, r.status, COUNT(*) AS recipients
FROM public.broadcast_recipients r
GROUP BY r.broadcast_id, r.status
ORDER BY r.broadcast_id, r.status;
```

Do not update job states or recipient statuses manually to force progress; evidence must establish whether the provider actually accepted a message.

## Acceptance checklist before live sends / rollout

- [ ] CI: lint, typecheck, unit/source tests, build on the exact HEAD.
- [ ] Migrations: clean replay, schema/privilege smoke, TEST applied and verified.
- [ ] Provider-neutral isolated dry run: enqueue, acquire lease, fence settlement, rollback test fixture with zero network sends.
- [ ] TEST Meta: one authorized recipient, approved template, header media, ACK delivered/read, restart.
- [ ] TEST OpenWA: one consented/pilot-allowed recipient, personalized text, native message ID, delivery/read/ACK, restart and QR/session changes.
- [ ] Crash injection at **before claim**, **after recipient reservation**, **after provider acceptance**, **before job settlement**, plus concurrent workers and disabled worker.
- [ ] Consent, account scoping, recipient phone snapshot, wrong provider/connection, quota, pacing, pause and reconciliation review.
- [ ] Bounded multi-recipient pilot with UX and audit review.
- [ ] Dedicated production scheduler/worker deploy, alerts, operator pause/cancel policy, and OW-14 GO decision.

This document is operational guidance. Deployment to Production is not authorized by committing this code.
