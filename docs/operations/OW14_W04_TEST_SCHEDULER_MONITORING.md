# OW14-W04 — TEST Agent Task Scheduler heartbeat & stop alerts

**Scope:** WACRM Supabase TEST only; no Production modification or unapproved WhatsApp dispatch. Source: WACRM branch refactor/service-platform-v2. Tracking: [SOF-51](https://linear.app/eproo/issue/SOF-51).

## What is now measured (no migration)

- Every successful/failing DB-fenced Agent Task scheduler tick updates existing `ai_agent_task_scheduler_heartbeat` (migration 192), independent of whether work exists.
- The account-authorized `GET /api/agent-tasks/worker` uses the existing `inspect_agent_task_schedule_health(p_account_id)` RPC: tenant-scoped backlog + one redacted global TEST heartbeat. Requires `agents.manage_tasks`; refuses non-TEST deployments; always `no-store`. The per-account STOP button still changes only `task_worker_enabled` and is NOT a Docker stop.
- The tasks panel polls every 30 seconds while visible, displays last success age/tick count/consecutive failures and a persistent `role=alert` on delayed, missing, unknown or stopped ticks. The alert cannot trigger a Task or resend an uncertain WhatsApp message.
- Redacted global heartbeat does NOT attest whether Windows, a GitHub scheduler or the Hostinger Docker sidecar invoked it. To validate the Docker container, inspect `docker compose ... ps` and logs on the actual host; disable duplicate pollers.

## Proposed TEST thresholds (calibrate after OW-13 pilot)

| Condition | State | UI / external monitor |
| --- | --- | --- |
| Success within 90 seconds, no immediate failures | healthy | Green |
| 90–179 seconds since success or recent failed tick | delayed | Amber in-app; external HTTP 503 |
| 180+ seconds since success | stopped | Red in-app; external HTTP 503 |
| Never seen a pulse or timestamp cannot be verified | missing/unknown | Warning; external HTTP 503 |
| Per-account `task_worker_enabled=false` | account paused | Suppress account-specific UI warning; shared heartbeat still visible |

These are **engineering provisional limits**, not approved SLOs. Scheduled service checks use a separate endpoint rather than reusing a Task-dispatch credential.

## Independent, authenticated outside-VPS monitoring

`GET /api/internal/agent-task-scheduler-health` requires `Authorization: Bearer <WACRM_MONITOR_SECRET>` with a **new, independent random secret of at least 32 characters**. `CRON_SECRET` is NOT accepted; this route is read-only and returns no Task/customer identifiers or payloads.

On TEST VPS, add to protected `.env.local` (do not commit):

~~~dotenv
WACRM_MONITOR_SECRET=<new-independent-secret-generated-with-openssl-rand-hex-32>
~~~

Recreate **only the WACRM app** to load new runtime settings:

~~~bash
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml up -d --no-deps --force-recreate app
~~~

Create an **external** HTTPS monitor from a different host/service, able to set a private Authorization header and receive a 503 alert. Probe `https://test-crm.eplu.cloud/api/internal/agent-task-scheduler-health` every 30–60 seconds, configure alert delivery to your approved on-call channel and a backup person, require 2 failed probes to page, and send a recovery notification on consecutive 200 results. Never paste the monitor secret in URL/query, screenshots or GitHub; never forward alerts with message bodies or customer identities. The monitor's actual provider, notification recipients, live delivery test and STOP/rollback drill require **separate operator configuration and evidence**. An on-VPS only watcher cannot detect complete VPS outages, so use an off-VPS monitor.

The endpoint returns 200 only when the heartbeat is healthy; 503 for delayed/stopped/missing/unavailable, 401 for invalid credentials, 403 for wrong project. A 503 may be a DB read outage; the operator must distinguish that from a dead worker.

## Manual verification (read only)

On VPS:

~~~bash
cd /home/eplu-test-crm/htdocs/test-crm.eplu.cloud
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml -f deploy/hostinger/compose.test-workers.yaml ps
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml -f deploy/hostinger/compose.test-workers.yaml logs --tail=50 scheduler
~~~

Observe WACRM Tasks → worker control card while scheduler is running, stopped, or paused. An account STOP must not restart the Docker scheduler or bypass Meta/OpenWA policy. **Do not intentionally kill the worker during an uncertain send**; reconcile the provider's native outcome first.

## Scope limitations / remaining SOF-51 DoD

This implementation supplies an account-controlled in-app alert and a private outside-monitor probe. No offsite paging service, alert recipient/backup, synthetic page delivery, full OpenWA webhook/ACK/media/capacity dashboard, host resource metric pipeline, verified recovery drill or production stop rehearsal has been configured by code. Record these as **PENDING**; do not close SOF-51 or call OW-14 production ready. NOTE-001 Auth warning and OW-12/13 live gates are independent.
