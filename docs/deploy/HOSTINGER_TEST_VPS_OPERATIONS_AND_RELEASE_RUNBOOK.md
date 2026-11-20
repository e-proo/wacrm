# WACRM — Hostinger TEST VPS operations, deployment and return-to-server runbook

> **Status: documented baseline / remote work paused by owner on 2026-11-20.** This document records verified repository contracts, an owner-supplied read-only VPS snapshot, and a future operator procedure. **It is not proof that all deployment commands have been tested end-to-end.** No remote VPS changes or live WhatsApp tests were performed to produce this document. It is **TEST-only**, not a Production deployment authorization.

- **Source of truth:** GitHub repository **e-proo/wacrm**, branch **refactor/service-platform-v2**. Check the branch HEAD and latest exact-SHA CI anew before every release; the historical implementation HEAD at documentation time was **43c2dea84766db747152be740bae95f994e2e5e6** (2026-11-20), [CI completed/success](https://github.com/e-proo/wacrm/actions/runs/44648209797) at that SHA. This runbook documentation commit is subsequent and has its own CI.
- **Related:** [Hostinger cutover guide](HOSTINGER_VPS_DOCKER_CUTOVER.md), [OW14-W06 capacity and restore baseline](../operations/OW14_W06_CAPACITY_BACKUP_TEST_BASELINE.md), [OW14-W04 scheduler monitoring](../operations/OW14_W04_TEST_SCHEDULER_MONITORING.md), [OW14 canonical plan](../../plans/WhatsApp%20Multi-Provider%20OpenWA%20Integration/10_OW14_PRODUCTION_READINESS_AND_ROLLOUT_PLAN.md).
- **Tracking:** [SOF-53/W06](https://linear.app/eproo/issue/SOF-53) remains **In Progress**; W05 live acceptance and W04 external paging remain open. W06 is **not** TEST restore-verified and OW14 is **not** production-ready.

## 1. Current owner decision: pause remote experimentation

From 2026-11-20, develop and run non-live technical tests on **Windows locally**. Do not pull, rebuild, restart, reconfigure gateway callbacks, run migrations, or execute live sends on VPS unless separately approved later. **This document is only a handoff.** Pausing experimentation does not automatically stop a running worker, unsubscribe an inbound webhook, or disable a linked WhatsApp session. The owner/operator must explicitly verify the runtime and decide whether to stop the TEST scheduler; this documentation operation did not stop it.

Never assume a stopped scheduler means a physical WhatsApp send has been recalled; reconcile outstanding ambiguous sends before restarting any delivery worker. Do not run simultaneous Windows and VPS dispatch pollers against the same TEST queues. WACRM inbound webhooks and Supabase data can remain active even while sending workers are paused.

## 2. Verified contracts versus observed VPS facts

| Subject | Status and source | Value / interpretation |
| --- | --- | --- |
| VPS provider | Owner-reported | Hostinger, TEST |
| Public app origin | Existing project operations documentation | **https://test-crm.eplu.cloud**; recheck DNS/TLS, proxy and actual routing on return |
| Repository directory | Previously used owner/operator SSH procedure; **reconfirm** | **/home/eplu-test-crm/htdocs/test-crm.eplu.cloud** |
| Suggested Git owner | Previously used SSH procedure; **reconfirm** | **eplu-test-crm** (never take ownership of all files as root) |
| Git remote and branch | Verified repository | **e-proo/wacrm**, **refactor/service-platform-v2**; not main |
| WACRM app | Verified Compose source | service **app**, Compose project **wacrm-hostinger**, image tag **wacrm-hostinger:local**, Next.js standalone, Node 20 Alpine |
| App port | Verified Compose source | Docker app listens **3000**, publishes to host **127.0.0.1:3100** by default; configurable via **WACRM_HOST_PORT** |
| Reverse proxy | Existing operations notes, not independently inspected here | CloudPanel / HTTPS front end to WACRM; exact vhost/proxy configuration, certificates and current route require operator read-only verification |
| WACRM worker | Verified TEST-only Compose overlay | **scheduler** sidecar, Node 20 Alpine, read-only filesystem, UID 10001, 192 MiB limit, 30-second stop grace |
| OpenWA | VPS read-only collector **classified** two containers | Independent of WACRM Compose. Names, ownership, engine versions, role of each container and persistence need later verification |
| Database/Auth/Storage | Existing system architecture | External **Supabase TEST**; Docker app does NOT apply Supabase migrations and does NOT back up Supabase |
| Backup and restore | No operational proof yet | No verified encrypted off-VPS profile backup, tested DB restore, snapshot consistency or measured RTO/RPO |

### Exact received VPS snapshot (not a peak benchmark)

Source: output supplied by operator from **node scripts/hostinger-capacity-baseline.mjs** on **2026-11-20T01:05:14.301Z**; scope **read_only_no_secrets**, schema **ow14-w06-host-capacity-v1**.

| Host metric | Sample |
| --- | ---: |
| Logical CPUs | 4 |
| RAM total | 15,992 MiB |
| RAM available | 10,943 MiB |
| 1-minute load | 0.74 |
| Root filesystem total | 192.7 GiB |
| Root filesystem available | 163 GiB |

| Docker role *as classified by collector* | Running count | CPU sample (sum %) | Memory sample (sum MiB) |
| --- | ---: | ---: | ---: |
| wacrm | 1 | 12.49 | 67.9 |
| scheduler | 1 | 0.23 | 11.7 |
| openwa | 2 | 4.53 | 1,247.2 |
| other | 1 | 0.18 | 435.7 |

- OpenWA classified containers had **2 total bind/volume mounts**, and mount inspection completed; this **does not prove** the session-auth profile is on a durable volume or backed up.
- Image hash prefixes observed: **sha256:86ab1d9f8526** and **sha256:1f5038b54f06**. Prefixes **are not** image versions, full digests, engine compatibility or a verified image release manifest.
- **Earlier 4 vCPU / 12 GB / 100 GB plan values were reported estimates; the 2026-11-20 script measured ~16 GiB / ~193 GiB.** Document both, prefer the dated actual reading, and measure again under real load.
- The **other** Docker service is not identified. Do not assign it to a component from CPU/memory heuristics.
- A single Docker/host sample establishes **neither** peak capacity, safe session count, restart time, backup integrity, nor RTO/RPO.

## 3. Logical deployment topology

~~~text
Browser/admin -> https://test-crm.eplu.cloud
                       |
             CloudPanel/reverse proxy [verify]
                       |
                127.0.0.1:3100
                       |
             wacrm-hostinger / app
                 (container :3000)
                /         |          \
       Supabase TEST   Meta Cloud   OpenWA authenticated HTTPS REST
            ^                              |
            |                    Separate OpenWA container(s)
            |                    + durable session profiles [verify]
            |                              |
            +--- WACRM unified inbound <-- signed HTTPS webhook
                       ^
                       |
           wacrm-hostinger / scheduler [TEST opt-in]
             internal http://app:3000
           (no direct OpenWA transport access)
~~~

The two OpenWA-classified containers are **not** created, upgraded, stopped, rebuilt or removed by **deploy/hostinger/compose.yaml** or its scheduler overlay. The diagram is a source/owner-based topology, **not** a network scan. Meta remains the default official production provider; OpenWA is an optional transport.

## 4. Canonical project files and configuration boundaries

| File/path (relative to repository root) | Purpose |
| --- | --- |
| **Dockerfile** | Node 20 Alpine build + non-root Next.js standalone runtime; copies .next/standalone, static and public |
| **deploy/hostinger/compose.yaml** | Hostinger app-only Compose: **name: wacrm-hostinger**; port, app health, restart, bounded logs |
| **deploy/hostinger/compose.test-workers.yaml** | Optional, **TEST-only** sidecar service **scheduler**; not loaded by base Compose |
| **deploy/hostinger/worker.example.env** | Template for private **.env.worker** at repo root; sending ACK defaults off |
| **scripts/selfhost-test-scheduler.mjs** | Jobs and authenticated internal poll scheduling; pinned Supabase TEST host, explicit ACK |
| **scripts/dev-with-agent-tasks.mjs** | Windows/local dev wrapper with potentially auto-enabled TEST delivery polling |
| **scripts/hostinger-capacity-baseline.mjs** | Read-only no-secrets snapshot, **not** backup |
| **.env.local** (never commit) | Build-time public client configuration + server runtime credentials; securely controlled |
| **.env.worker** (never commit) | Worker shared CRON_SECRET/AUTOMATION_CRON_SECRET and explicit TEST worker ACK |
| **supabase/migrations/** | Additive database migrations; separate verified TEST deployment only |
| **.github/workflows/ci.yml** | Lint, typecheck, tests, build and scheduler/capacity regression |
| **docs/deploy/HOSTINGER_VPS_DOCKER_CUTOVER.md** | Historical cutover and sensitive environment guidance |

### Environment and secrets rules

1. **.env.local** must target the intended Supabase **TEST** project. Keep **NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_SITE_URL, NEXT_PUBLIC_APP_LOCALE** aligned with build args. They are baked into the client bundle, so any change requires **rebuild**.
2. Keep **SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY, META_APP_SECRET**, configured OpenWA gateway allowlists, webhook signing identity, and any additional runtime secrets **server-only**. Using a different **ENCRYPTION_KEY** against the same encrypted database may make existing provider credentials unreadable. Do not rotate or replace it casually.
3. **.env.worker** is private, created from **deploy/hostinger/worker.example.env** and uses the SAME **CRON_SECRET** and **AUTOMATION_CRON_SECRET** configured for the app. The explicit **WACRM_TEST_WORKERS_ACK=I_ACCEPT_TEST_WHATSAPP_SENDS** can trigger previously approved queued WhatsApp sends; default **off** is safer.
4. Limit private files to the deploy owner: **chmod 600 .env.local .env.worker** (only for existing files). Docker socket access is privileged; restrict operator permissions.
5. Never paste environment values, entire **docker inspect**/**docker compose config**, volume source paths, QR, WhatsApp numbers, session profiles, HMAC keys, or service-role credentials into GitHub, Linear, public chat or application logs.
6. Do not add Production credentials, migrations or endpoints to this TEST Compose deployment. **WACRM_MONITOR_SECRET** and outside-VPS alert routing are optional and not yet configured/approved (PROJECT_NOTES.md NOTE-019).

## 5. Local Windows development during VPS pause

From the authorized local Windows repository (example previously reported **D:\progects\node\wacrm**, **verify it exists**):

~~~powershell
Set-Location 'D:\progects\node\wacrm'
git branch --show-current
git status --short
git fetch origin refactor/service-platform-v2
git log -1 --format="%H %s"
npm ci
npm run lint
npm run typecheck
npm test
npm run build
~~~

- Use local source and CI for non-live work; **do not equate local tests with provider-backed TEST acceptance**. Do not modify Production from local Windows either.
- **npm run dev** uses **scripts/dev-with-agent-tasks.mjs**; for coding/UI review without actual sends, explicitly opt out of the three local TEST auto-pollers **before** starting dev:

~~~powershell
$env:WACRM_DEV_AGENT_TASK_WORKER = 'off'
$env:WACRM_DEV_BROADCAST_WORKER = 'off'
$env:WACRM_DEV_OPENWA_DEFERRED_WORKER = 'off'
npm run dev
~~~

- This disables the three **dev-wrapper** pollers, **not every possible external GitHub/Supabase/VPS scheduler**, and does not deactivate inbound webhooks. Check other active schedulers before approving sends.
- Work and commit on **refactor/service-platform-v2**, and review exact HEAD, CI and migrations after any code/schema change. Keep GitHub and local Windows synchronized; do not assume a prior SHA remains latest.

## 6. Read-only VPS re-entry checklist — do this only when experiments resume

Connect by authorized SSH; verify actual host/domain, account and directory before using commands. This guide deliberately contains **no SSH private keys, password, public IP or secrets**.

~~~bash
cd /home/eplu-test-crm/htdocs/test-crm.eplu.cloud
pwd
git remote -v
git branch --show-current
git rev-parse HEAD
git status --short
node --version
docker version
docker compose version
free -h
df -h
uptime
node scripts/hostinger-capacity-baseline.mjs
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml ps
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml -f deploy/hostinger/compose.test-workers.yaml ps
~~~

**Do not** publicly share full **git remote -v** if it contains embedded credentials. If directory, Git owner, branch or files do not match, **stop**; do not overwrite the old deployment. Do not print the values of **.env.local** or **.env.worker**. Check available RAM/disk and free space for the Node/Next.js image build.

For an authorized private operator only, inspect **names and image versions**, and then locally review OpenWA per-container mount **type/destination** (not raw source/profile path), restart policy, active engine, session ownership and persistence. Do not run a second gateway with the same profile.

~~~bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker system df
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml images
~~~

Record in a **private** operations register: real container ID/name, complete image ID/digest, engine/version, volume owner/backup contract, TLS reverse proxy configuration, DNS, OpenWA webhook URL and live session status; **redact all identifiers and secrets in public notes**.

## 7. Authorized release to VPS — staged procedure, not to run now

**Prerequisites:** Owner approves a TEST maintenance window and release SHA; no ambiguous physical sends left unreviewed; Supabase migrations (if any) applied to TEST through a separately verified, additive change process; signed webhooks and callback owner identified; backup/rollback compatibility reviewed; enough VPS free space; and **latest exact-release-HEAD GitHub Actions completed/success**. Coordinate Windows/GitHub/VPS workers so there is a single intentional TEST dispatch owner.

### A. Fetch approved code without discarding server changes

~~~bash
cd /home/eplu-test-crm/htdocs/test-crm.eplu.cloud
git branch --show-current
git status --porcelain
# STOP if dirty or branch != refactor/service-platform-v2
sudo -u eplu-test-crm -H git -C "$PWD" fetch origin refactor/service-platform-v2
sudo -u eplu-test-crm -H git -C "$PWD" rev-parse FETCH_HEAD
sudo -u eplu-test-crm -H git -C "$PWD" log --oneline HEAD..FETCH_HEAD
# Verify FETCH_HEAD against the explicitly approved SHA and CI first.
sudo -u eplu-test-crm -H git -C "$PWD" merge --ff-only FETCH_HEAD
git rev-parse HEAD
~~~

The account name and path come from prior operator procedure: verify actual ownership before running. **Never use git reset --hard, force pull or an unreviewed branch switch to resolve a dirty checkout.** No deployment should automatically track an unverified newer HEAD.

### B. Preserve evidence and previous app image

Before rebuilding, record original Git SHA, image IDs, current scheduler state and webhook routing in a **private** release record. The Compose image name is a reusable local tag, not an immutable digest. Preserve a **separate tagged reference to the old app image** for a schema-compatible app-only rollback (replace example timestamp with actual release ID):

~~~bash
docker image inspect wacrm-hostinger:local --format '{{.Id}}'
docker image tag wacrm-hostinger:local wacrm-hostinger:rollback-YYYYMMDD-HHMM
~~~

If the existing tag is missing, investigate rather than assuming a successful backup. An old image is **not a database backup**. Never delete OpenWA profiles/volumes or downgrade migrations as part of an app rollback.

### C. Check and build

~~~bash
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml config --quiet
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml build app
~~~

- **Do not post full docker compose config**; it may expand environment/secrets.
- Rebuild is required after code or build-time **NEXT_PUBLIC_*** changes. Merely restarting the container cannot update client-bundle settings.
- This build is only for WACRM, **not** for the separately managed OpenWA service.

### D. Coordinate workers, replace only app, verify

If the TEST scheduler is running, explicitly review in-flight/ambiguous sends and approved backlog; stop it **before** the controlled app swap. If it was already stopped, leave it stopped. This operation affects the scheduler only; do not stop OpenWA.

~~~bash
docker compose --env-file .env.local \
  -f deploy/hostinger/compose.yaml \
  -f deploy/hostinger/compose.test-workers.yaml stop scheduler

docker compose --env-file .env.local \
  -f deploy/hostinger/compose.yaml \
  up -d --no-deps --force-recreate app

docker compose --env-file .env.local -f deploy/hostinger/compose.yaml ps
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml logs --tail=80 app
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' --max-time 15 http://127.0.0.1:3100/login
~~~

Expect the app container **healthy**; note that the current Dockerfile healthcheck accepts HTTP 2xx–4xx from root, so this alone does **not** validate sign-in, the browser, a job, Meta, OpenWA or webhooks. Verify HTTPS domain, actual login, API authorization, tenant isolation, session picker, callback signature/dedup, queued state and absence of unexpected sends. Avoid dumping raw session/messages in release logs.

**Restart scheduler only if it was previously approved/running and the backlog is deliberately authorized.** A web deployment can remain healthy with scheduler intentionally stopped.

~~~bash
docker compose --env-file .env.local \
  -f deploy/hostinger/compose.yaml \
  -f deploy/hostinger/compose.test-workers.yaml start scheduler

docker compose --env-file .env.local \
  -f deploy/hostinger/compose.yaml \
  -f deploy/hostinger/compose.test-workers.yaml ps

docker compose --env-file .env.local \
  -f deploy/hostinger/compose.yaml \
  -f deploy/hostinger/compose.test-workers.yaml logs --tail=60 scheduler
~~~

Never run **up -d scheduler** or **start scheduler** solely as a UI smoke test: it can invoke already approved tasks/broadcast/automation endpoints. An intentionally manually stopped scheduler stays stopped through normal Docker restarts; verify after host restart.

## 8. Scheduler operating contract (TEST only)

**Source:** deploy/hostinger/compose.test-workers.yaml + scripts/selfhost-test-scheduler.mjs. The sidecar talks to WACRM internally at **http://app:3000** with private authorized headers; **does not** send directly to OpenWA.

| Job | Endpoint | Method | Cadence |
| --- | --- | --- | --- |
| Agent task dispatch | /api/internal/ai-agent-task-worker | POST | 15 s |
| Broadcast delivery | /api/internal/whatsapp-broadcast-worker | POST | 15 s |
| OpenWA deferred receipts | /api/internal/openwa-deferred-worker | POST | 15 s |
| Agent recovery | /api/internal/ai-agent-worker | POST | 60 s |
| Automations | /api/automations/cron | GET | 60 s |
| Flow automation | /api/flows/cron | GET | 300 s |

Per job, requests are sequential and bounded by a timeout; jobs operate concurrently with one another. **The sidecar uses a pinned TEST Supabase host and a required explicit sending ACK; it refuses the wrong Supabase target.** Credentials are not logged. **restart: unless-stopped** means it can resume after Docker/VPS restart if authorized and active.

**Operational pause (only with approval and after checking ambiguous sends):**

~~~bash
docker compose --env-file .env.local \
  -f deploy/hostinger/compose.yaml \
  -f deploy/hostinger/compose.test-workers.yaml stop scheduler
~~~

This stops the Docker sidecar, **not** the WACRM app, independent Windows dev pollers, GitHub Actions, third-party cron or the OpenWA transport itself. Check the worker heartbeat/UI and other schedulers separately. A per-account worker STOP button is not identical to Docker **stop scheduler**. Never use **docker compose down -v**, **docker volume prune**, blind resend or deletion of session auth state.

## 9. App-only rollback and OpenWA isolation

Rollback **is conditional**, not an automatic safety guarantee:

1. **Stop/hold future TEST dispatch** after evaluating in-flight and ambiguous sends; capture symptoms, timestamp, approved rollback SHA and current CI/schema evidence.
2. Verify the previously tagged app image is actually present, and that its older binary is compatible with the **current Supabase TEST migrations, credential formats and webhook contract**. **Applied migrations are immutable and are not automatically rolled back.**
3. If verified, re-tag the preserved prior image to the Compose app tag and **recreate app without build** (deliberate human action, not a routine deployment).
4. Recheck health, login, Meta and OpenWA routing, signed webhook single-target ownership, idempotent receipts and queue reconciliation. Resume only approved scheduler traffic after confirming uncertainty state.

Illustrative **authorized app rollback** (use the real preserved image tag from the private register, never the literal placeholder):

~~~bash
docker image tag wacrm-hostinger:rollback-YYYYMMDD-HHMM wacrm-hostinger:local
docker compose --env-file .env.local -f deploy/hostinger/compose.yaml \
  up -d --no-deps --force-recreate app
~~~

**Do not** roll back by deleting database tables, rotating **ENCRYPTION_KEY**, restoring stale WhatsApp profile over an active session, starting a second gateway for one linked number, swapping provider without approval, or blindly replaying sends. If schema compatibility is not proven, freeze rollback and use a corrective release or isolated restore plan.

## 10. OpenWA remains a separate failure/recovery domain

- Two containers were **classified** as OpenWA; verify actual ownership and whether one is a browser/helper before claiming two distinct gateway sessions.
- Current WACRM Compose does not manage OpenWA image upgrade, lifecycle, tunnel/HTTPS, persistent volumes or linked-device QR. Document its actual deploy command, Compose project or docker run/service separately **only after read-only inventory**, never fabricate it from WACRM Compose.
- Record authenticated WACRM -> OpenWA HTTPS REST origin and OpenWA -> WACRM signed webhook target. A gateway base-URL edit and a webhook callback registration are different configuration paths. Keep **one intended WACRM callback** per connection and preserve HMAC identity when changing HTTPS origin.
- A socket/browser/version failure is not a reason to delete browser profiles. Upgrade engine/browser only with a compatible tested profile snapshot and rollback plan.
- Connection keys, session QR/auth profiles, sender IDs, webhook payload bodies and host mount source paths belong in a protected private secret/inventory store, **not this document**.
- No provider-native match => **requires reconciliation/operator disposition**, never fabricate delivery success/failure. Meta remains the default production provider; no OpenWA automatic failover.

## 11. Backup, secrets, Supabase and recovery gates (still pending)

Treat these as separate assets, with explicit owner, tested encryption/decryption, retention and **off-VPS** copy:

1. **OpenWA:** consistent, compatible encrypted backup of **auth/browser session profiles** and gateway config; read-only mount inventory first. Never assume a live file copy is a consistent recoverable profile snapshot. Restore in an isolated environment that cannot connect a duplicate WhatsApp client to the same number; when impossible document manual controlled re-QR.
2. **WACRM:** private .env files and key-custody/recovery procedure, release SHA and image digests (without exposing secret values). Reusing existing Supabase encrypted rows requires compatible keys.
3. **Supabase:** independently verify database PITR/vendor backup coverage, Auth configuration and object Storage bucket backups/versions; a VPS snapshot does **not** back up managed Supabase DB or media. Include migration ledger and restore/tenant checks.
4. **Recovery drill:** isolated TEST target, compatible image/profile, app login, scheduler safe disabled-by-default, signed webhook dedup, cross-tenant isolation, reconciliation (no blind resend), measured backup and restore duration and data loss. Only **measured** RTO/RPO can be reported as achieved.
5. **Owner approvals:** Define retention, RTO/RPO targets, backup key custody, off-VPS location, restore decision owner and incident roles. No backup creation/restore has been performed by this documentation.

## 12. Go / no-go release checklist

- [ ] Exact **refactor/service-platform-v2** HEAD and approved release SHA recorded, no dirty server checkout
- [ ] CI at **exact** release SHA is **completed/success** including Lint, Typecheck, Vitest, Build and relevant DB replay/smokes
- [ ] VPS read-only state recaptured: host RAM/CPU/disk, app/scheduler/OpenWA image digests, containers, persistent mount inventory
- [ ] Intended environment proven **Supabase TEST** with keys accessible only to the app; no Production access or configuration
- [ ] Migration compatibility and additive TEST migration ledger reviewed; no automatic schema migration from Compose
- [ ] Current queued jobs, ambiguous sends and worker ownership reviewed before any scheduler restart
- [ ] Current app image safely retained; documented rollback is compatible with schema and profile formats
- [ ] OpenWA transport volumes and session state protected; gateway not recreated by WACRM release
- [ ] Deployment build and app health + login + HTTPS + callback checks successful
- [ ] Approved scheduler only resumed deliberately; no concurrent Windows/GitHub/VPS pollers and no accidental queued sends
- [ ] Encrypted off-VPS backups, key custody and isolated restore evidence reviewed **before calling W06 TEST verified** (currently pending)
- [ ] W05 media/Meta live acceptance, W04 external alerts, NOTE-001 Supabase Auth protection, OW12/OW13 pilots and OW14 production decision remain independently gated; no Production GO from this runbook

## 13. Unknowns to collect privately on return

**Do not fill these from inference**: actual VPS SSH connection address/port; current reverse proxy vhost config and TLS owner; DNS provider records and change authority; exact OpenWA container names/images/versions and distinct roles; real mount sources/destinations and durable profile backup path; OpenWA service startup command/restart policy; active current WACRM deployment SHA/image; app health verification from authenticated browser; all active Windows/GitHub/external scheduler ownership; Supabase backup policy and Storage bucket coverage; site bandwidth/peak CPU/memory per Chromium session; log rotation for OpenWA; encrypted backup provider/retention and custodian; tested rollback/restore and measured RTO/RPO. Store sensitive operational data in a protected owner-controlled vault, not public GitHub/Linear.

### Evidence recording template (redacted)

| Field | At next approved server session |
| --- | --- |
| Visit UTC time / operator | PENDING |
| Approved target SHA + exact CI link | PENDING |
| Local Windows SHA / server before / server after | PENDING |
| App image ID before/after (hash only) | PENDING |
| Scheduler before/after + single dispatch owner | PENDING |
| OpenWA role/version/digest/profile backup method | PENDING |
| VPS CPU/RAM/disk idle + bounded load | PENDING |
| Supabase TEST migration ledger / backup scope | PENDING |
| Health/login/Meta/OpenWA signed webhook test | PENDING |
| Backup offsite and isolated restore proof | PENDING |
| Rollback outcome / reconciliation issues | PENDING |

**Operating rule:** keep local Windows implementation and GitHub CI moving; no new VPS experiment or live provider test until expressly resumed. When resuming, this runbook is the operator starting point; source code, CI, actual VPS and TEST evidence always supersede stale documentation.
