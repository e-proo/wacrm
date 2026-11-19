# Hostinger VPS — safe WACRM Docker cutover (OW14-W01/W02)

**Preparation only. No Production approval or remote server change is implied.** Source of truth: e-proo/wacrm, branch refactor/service-platform-v2.

## Operator-reported baseline (2026-11-19)

- Hostinger VPS: 4 vCPU, 12 GB RAM, 100 GB storage.
- An independent OpenWA Docker container is ALREADY RUNNING on this VPS, with an active session linked to the latest Windows WACRM. Do not replace it, restart it casually, delete its volume, or re-QR the session.
- WACRM latest runtime is on Windows. An old test-only WACRM is on the VPS via NPM; it has no customer accounts per owner, but its Supabase project, queued jobs and webhook destinations must still be checked.
- New app compose: deploy/hostinger/compose.yaml. Isolated Compose project name wacrm-hostinger; only one app service, bound to 127.0.0.1:3100 by default.
- Optional **TEST only** workers: deploy/hostinger/compose.test-workers.yaml, never included in the base command. Never point this at a Production database.

## 1. Read-only VPS inventory first

Run via an authorized Hostinger SSH account:

~~~bash
hostnamectl
free -h
df -h
docker version
docker compose version
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
ss -ltnp | grep -E ':(80|443|3000|3100)\b' || true
~~~

Determine which process/supervisor owns the old NPM app (systemd/pm2), its reverse-proxy virtual host, DNS/TLS provider, and OpenWA container image/engine version, volumes, health and restart policy. **Inspect OpenWA read-only**: never publish container environment, session profiles, QR, tokens or HMAC keys. Verify OpenWA profile storage is persistent. Measure RAM and disk before running a Next.js Docker build beside Chromium; these VPS specs are a starting point, not verified production capacity.

## 2. Stage the source alongside the old app

~~~bash
mkdir -p ~/deploy
cd ~/deploy
git clone --branch refactor/service-platform-v2 https://github.com/e-proo/wacrm.git wacrm-docker
cd wacrm-docker
git rev-parse HEAD
~~~

Do not overwrite an existing folder or assume the branch has the same SHA as this runbook. Compare current immutable SHA with a **completed/success** GitHub CI run. No OpenWA repository or container is involved in this clone.

## 3. Secure environment: preserve encryption identity

~~~bash
cp .env.local.example .env.local
chmod 600 .env.local
~~~

Transfer the required values securely from the **working Windows TEST configuration**, not through GitHub, public chat, process command-line arguments or shell history. Do not commit .env.local. Verify:

- The correct **Supabase TEST** URL, anon key and service-role key. No new Production project or migration is authorized.
- **The SAME ENCRYPTION_KEY** when reusing encrypted provider credentials in the existing Supabase project. Generating a new key can make stored connection credentials unrecoverable; retain any other key versions in active use.
- META_APP_SECRET, required server-side settings and OpenWA allowlisted HTTPS gateway origin. Ensure the new Docker app can actually resolve/reach the saved gateway URL: localhost on Windows is NOT localhost inside Docker. Avoid expiring tunnel names.
- NEXT_PUBLIC_SITE_URL points at the intended canonical HTTPS WACRM origin, ALLOWED_INVITE_HOSTS includes only trusted hostnames, and WACRM_HOST_PORT=3100 (or an unused local host port).
- Distinct strong CRON_SECRET and AUTOMATION_CRON_SECRET are set for later workers, but **do not activate workers yet**.

Docker operators can see container environments, so lock down the Docker socket, deploy user and VPS firewall. Next.js bakes NEXT_PUBLIC_* into the build, so rebuild after changing them. Supabase migrations are NOT run automatically by this Compose package.

## 4. Build and verify WACRM without cutting over traffic

From the newly cloned repo root:

~~~bash
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml config --quiet
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml build app
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml up -d app
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml ps
curl -I --max-time 15 http://127.0.0.1:3100/login
~~~

The loopback port deliberately avoids the old NPM app. Base Compose contains **no timer and no WhatsApp sending worker**. Verify browser login, selected Supabase environment, tenant isolation, WhatsApp connection list and existing OpenWA REST reachability. Check that neither the old app nor Windows is still executing TEST workers before enabling any new ones. Do not let proxy/CDN cache /api/*, signed-in pages or private conversations.

## 5. Cut over HTTPS and webhooks only after verification

1. Identify the actual reverse proxy (Nginx, Caddy or Traefik). Change **only the WACRM upstream** to http://127.0.0.1:3100 under its canonical HTTPS hostname, once this deployment is healthy. Keep OpenWA's URL, volumes, ports and separate Compose project unchanged.
2. Check WACRM login, session picker, inbox, image/static assets, Supabase Auth allowed redirect URLs, Meta default routing and OpenWA API reachability on the intended TEST dataset.
3. **During an explicitly authorized TEST acceptance window**, reconfigure the existing OpenWA signed webhook target to the new WACRM HTTPS /api/whatsapp/openwa/webhook endpoint; keep the existing signing secret and verify HMAC, replay/dedup, inbound data and receipt status. Confirm no event gap or duplicate receiver before withdrawing the old callback. Do not force the OpenWA session to reauthenticate.
4. Stop only the **specific old NPM WACRM process** after confirming routing, not all pm2 processes, Docker projects or ports. Preserve its config and a documented rollback path. Do not run destructive container/volume cleanup.

## 6. Optional TEST workers — explicit second gate

Do **not** start this just to test the new UI. Before enabling, stop the Windows auto-worker or set all three Windows flags to off and restart Windows dev:

- WACRM_DEV_AGENT_TASK_WORKER=off
- WACRM_DEV_BROADCAST_WORKER=off
- WACRM_DEV_OPENWA_DEFERRED_WORKER=off

Also disable any GitHub SCH-4 TEST scheduled trigger pointing at these queues, and ensure no other server cron exists. Database leases help with concurrency but do not authorize multiple operators. Confirm tenant/connection/Pilot/cap/recipient approvals: already-queued tasks **can actually send** when workers start.

Create private .env.worker at the **repository root** using deploy/hostinger/worker.example.env. Copy only the two existing shared secrets from app .env.local; chmod 600 .env.worker. Set the explicit acknowledgement WACRM_TEST_WORKERS_ACK=I_ACCEPT_TEST_WHATSAPP_SENDS. The sidecar also refuses any Supabase URL except the pinned WACRM TEST project, without altering production guardrails.

~~~bash
docker compose --env-file .env.local \
  -f deploy/hostinger/compose.yaml \
  -f deploy/hostinger/compose.test-workers.yaml up -d scheduler
docker compose --env-file .env.local \
  -f deploy/hostinger/compose.yaml \
  -f deploy/hostinger/compose.test-workers.yaml ps
~~~

The sidecar invokes the **existing authenticated WACRM endpoints**, not OpenWA directly: TEST agent tasks, broadcasts and deferred receipts (15-second intervals, no overlapping requests per job); general agent recovery and automations (60 seconds); stale flows (5 minutes). Endpoint authorization, account scope, idempotency, provider policy and Pilot remain owned by WACRM. Logs contain job/status only, no response bodies.

To stop it separately from the WACRM app:

~~~bash
docker compose --env-file .env.local \
  -f deploy/hostinger/compose.yaml \
  -f deploy/hostinger/compose.test-workers.yaml stop scheduler
~~~

Stopping a scheduler does not determine the outcome of in-flight or ambiguous WhatsApp sends. Reconcile uncertain provider results; **never blind-resend**.

## 7. Rollback and release evidence

- Preserve the original NPM start command/service identifier and old reverse-proxy upstream until the new app is proven. Roll back proxy routing only after checking compatibility with the current TEST schema and routing webhooks to **one** receiver.
- Never downgrade applied migrations, rotate ENCRYPTION_KEY blindly, delete OpenWA session volumes, or run docker compose down -v / docker system prune --volumes.
- Record actual VPS topology, current Git SHA, successful CI, image ID, WACRM/ gateway HTTPS routes, session-profile persistence, scheduler ownership, TEST migration ledger and verified restore/rollback evidence (redacted).
- OW14-W02 gateway storage and restart proof, W04 observability, W06 backup/restore, W08 release identity, OW-12 live acceptance, OW-13 formal pilot, and W09 signed release decision remain separate gates. NOTE-001 also remains open until the hosted Auth leaked-password setting is enabled and Security Advisor is rechecked, plus security owner sign-off.
- No live Production traffic or Production database changes are authorized by this package.

**Tracking:** Linear SOF-48 (W01), SOF-49 (W02), SOF-50 (W03), SOF-55 (W08). Canonical plan: plans/WhatsApp Multi-Provider OpenWA Integration/10_OW14_PRODUCTION_READINESS_AND_ROLLOUT_PLAN.md.
