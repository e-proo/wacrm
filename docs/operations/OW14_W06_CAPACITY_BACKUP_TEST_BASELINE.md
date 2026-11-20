# OW14-W06 — TEST VPS capacity, encrypted backup and restore baseline

**Scope:** P0/plan and read-only operator collection. Next workstream after W05's historical ACK backlog disposition; W05 live acceptance remains open. Tracking: [SOF-53](https://linear.app/eproo/issue/SOF-53). No Production modification or OpenWA profile deletion/relink.

## 1. Known configuration versus measurements

| Item | Known evidence | Not yet verified |
| --- | --- | --- |
| Host | Owner-reported Hostinger VPS: 4 vCPU, 12 GB RAM, 100 GB storage | RAM pressure, CPU throttling, filesystem used/free, swap, IOPS, provider backups |
| WACRM | CloudPanel reverse proxy to TEST Docker app, `127.0.0.1:3100:3000`, `restart: unless-stopped`, 45-second graceful stop, `local` logs 10 MB × 5 | App resident RSS/peak, restart times, session connection concurrency, CDN/TLS baseline |
| Scheduler | `deploy/hostinger/compose.test-workers.yaml`: separate node:20-alpine TEST scheduler, 192 MiB limit, 30s stop grace, Docker restart | Actual runtime pulse attribution and CPU/memory/timeouts under multi-task load |
| OpenWA | Owner reports separate existing Docker container, connected active WhatsApp session | Exact image digest/version, engine/browser resident memory, session auth volume mounts, durable profile backup, worker/page count, log rotation |
| Database/storage | Supabase TEST with WACRM data and signed webhooks | Vendor managed backup coverage/recovery policy, media bucket versions, encryption/restore proof |

**Do not infer** session capacity or guaranteed RTO/RPO from the VPS plan alone. No more sessions should be admitted based solely on 12 GB RAM.

## 2. Safe measurements for the operator (no secrets)

From VPS SSH (read-only; keep full output private if names are sensitive):

```bash
free -h
df -h
uptime
docker stats --no-stream
docker system df
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

Do not paste complete `docker inspect` or `docker compose config` outputs in public support channels because environment variables and auth mounts may appear. To discover OpenWA persistent storage safely, review container mount **names/types/destinations only** with a local filtered inspection and keep host source paths private. Record measurements at idle, one-task send, concurrent permitted task burst and media transfer; use time, peak RSS, CPU %, restart count, disk delta, media temp growth and queue latency. Avoid running a synthetic send outside the approved TEST cohort.

## 3. Backup boundary and ownership

1. Preserve the existing running OpenWA gateway and **its persistent linked-device session profiles**. Never use `docker compose down -v`, destructive `docker volume prune`, manual deletion of WhatsApp profile, or a second gateway process against the same session volume.
2. Identify container image digest, engine version, browser/profile compatibility and volume paths before any backup/upgrade. Plan a consistent snapshot with the gateway safely quiesced, short tested maintenance window, encrypted offline/off-VPS copy, retention policy and access controls. If no consistent snapshot is possible, document a session re-QR recovery route rather than falsely promising transparent restore.
3. Treat Supabase Database, Auth, Storage, WACRM configuration/secrets and OpenWA encrypted state as **different recovery domains**. Provider-managed backups do not necessarily include custom host volumes or all object storage. Never print tokens, encrypted key material or profiles in logs/Linear/GitHub.
4. Propose RTO/RPO **targets only after operator approval**; record measured backup, offline restore, session reconnect and data integrity in a completely isolated TEST environment. Restore must never connect two engine instances to the same WhatsApp number simultaneously.
5. Keep Meta Cloud API as default; no automatic provider failover or blind replay of pending WhatsApp sends after a crash. Require reconciliation and tenant isolation checks after restore.

## 4. Acceptance and gating

- Evidence pack: timestamped 3-point host metrics (idle, 1 allowed task, permitted burst), deployment/image digests (hashes only), disk/volume inventory, per-session browser RSS, concurrency budget and headroom proposal.
- Backup manifest: what was backed up, encryption method, object retention, secure owner/backup owner, key custody, consistency point, off-VPS copy, restore compatibility.
- Restore drill: isolated TEST target, profile compatibility, DB integrity, WACRM login, scheduler health, OpenWA session readiness or documented QR, signed webhook idempotency, no blind resend. Record actual RTO and RPO.
- **Not yet completed:** real VPS metrics, encrypted backups, restore drill, measured RTO/RPO or production GO decision. Keep SOF-53 In Progress and OW-14 production NO-GO pending verification.

## 5. Repeatable host capacity snapshots

New read-only Node 20+ script: scripts/hostinger-capacity-baseline.mjs. From the VPS WACRM directory run:

    node scripts/hostinger-capacity-baseline.mjs

The output contains aggregate container CPU/memory grouped as WACRM / OpenWA / scheduler / other, CPU/RAM/root disk metrics and *counts* of OpenWA persistent mounts, plus an image hash prefix. It deliberately never outputs secret environment variables, volume source paths, WhatsApp profiles, phone numbers, container names or credentials; it does not start/stop containers, send messages, create backups or edit data.

Run a baseline at idle first; only schedule a one-task snapshot and bounded multi-target/media load during a separately approved TEST send window. A single point-in-time reading is **not** peak resource headroom, session capacity, backup validation or measured RTO/RPO. An unrecognized gateway name is counted as OTHER, so validate classification locally. If Docker access fails the script reports unavailable, never 'all healthy'.

Tests: node --test scripts/hostinger-capacity-baseline.test.mjs. These check read-only command allowlist, Docker unit handling and no output of secrets, container identities, or mount paths.
