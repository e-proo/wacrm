# OW14-W01 — Architecture, Deployment & Dependency Baseline (initial audit)

**Audit date:** 2026-11-13  
**Source:** e-proo/wacrm, `refactor/service-platform-v2`  
**Audited HEAD:** `08f6c65ce3efd360b34e7d9bd33ee15048389503`  
**Linear:** SOF-48  
**Status:** initial source audit documented; deployment/TEST evidence pending. **Not production ready.**

## 1. Source-grounded topology

```text
Customer / Admin
       |
       v
WACRM Next.js app (Dockerfile, docker-compose.yml: app :3000)
       |                    |
       |                    +--> Supabase (external DB + Storage)
       |
       +--> WhatsApp transport router (account-scoped connection)
                |                          |
                +--> Meta adapter          +--> OpenWA adapter/client
                     (default)                   |
                                                HTTPS authenticated REST
                                                  |
                                         Separate OpenWA gateway [deployment NOT evidenced]
                                                  |
                                            WhatsApp Web session
                                                  |
                                       signed webhook to WACRM
                                       /api/whatsapp/openwa/webhook
                                                  |
                                         unified inbound processor
```

This is a **code architecture**, not a verified production network diagram. No OpenWA gateway deployment manifest or live topology was established by this audit. Do not treat a developer tunnel as a production ingress.

## 2. Evidence and dependencies

| Component | Current repository evidence | Verified / limitation |
| --- | --- | --- |
| WACRM packaging | `Dockerfile` uses Node 20 Alpine, standalone Next.js, non-root runtime | Source verified; deployed image digest, running Node version and production host unknown |
| WACRM Compose | `docker-compose.yml` defines only `app`, host port configurable, restart and HTTP healthcheck | Source verified; does not deploy OpenWA gateway, DB or durable queue |
| External DB and storage | `docs/docker.md` states Supabase external and `chat-media` storage | Source verified; actual TEST/Production projects, backup and retention require separate read-only evidence |
| Scheduled work | `docs/docker.md` requires external scheduler for cron/AI worker | Scheduler provider, cadence, availability and alerting not verified |
| Provider routing | `src/lib/whatsapp/transport/router.ts` uses account-scoped `whatsapp_connections`, defaults to Meta when no connection ID | Source verified; needs current negative TEST and Meta regression evidence |
| OpenWA credentials | `src/lib/whatsapp/transport/openwa/credentials.ts` account-scopes connection and encrypted credential row, decrypts server-side | Source verified; secret store, rotation and live permissions require W03 |
| OpenWA REST | `src/lib/whatsapp/transport/openwa/client.ts` validates HTTPS URL and restricts internal hosts unless allowlisted | Source verified; actual DNS, TLS certificate, firewall, network path and gateway version unknown |
| Signed webhook | `src/app/api/whatsapp/openwa/webhook/route.ts` reserves signed event, waits for processing, uses 503 retry for in-flight/failure, 202 after completion | Source verified; live retry, proxy timeout, lease recovery, gateway redelivery and end-to-end delivery require testing |
| Media/status | `src/lib/whatsapp/transport/openwa/*`, `src/lib/whatsapp/status-lifecycle*` | Implementation present; live media, read ACK and uncertain send reconciliation not established by source alone |
| Database evolution | `supabase/migrations/145..156` include OpenWA credentials, receipt leases, guardrails, pilot admission and TEST toggle | Source inventory; migration ledger and clean replay must be refreshed against exact release SHA |
| Security debt | `PROJECT_NOTES.md` NOTE-001 open | Production security gate remains blocked pending current advisor triage |

## 3. Dependency / ingress contract

- WACRM -> Supabase: external DB/Auth/Storage; actual DNS/TLS/network allowlists TBD.
- WACRM -> Meta: default official provider; Meta regression is mandatory.
- WACRM -> OpenWA: authenticated HTTPS REST, connection-scoped encrypted credentials, pinned gateway identity required.
- OpenWA -> WACRM: signed HTTPS webhook at `/api/whatsapp/openwa/webhook`; gateway retries the **same event** on 503, not a second WhatsApp send.
- OpenWA session -> WhatsApp Web: durable profile and exclusive session owner are production design requirements, not verified deployment facts.
- Background cron/AI worker -> WACRM: external scheduler is documented; actual schedule and failure monitoring unknown.

## 4. Gap and risk register

| ID | Gap / risk | Severity | Proposed owner | Mitigation / required evidence |
| --- | --- | --- | --- | --- |
| W01-01 | No verified OpenWA host topology, image digest or isolated gateway manifest | HIGH | Platform/SRE | W02: pinned deployment artifact, gateway host, network diagram and TEST upgrade evidence |
| W01-02 | DNS/TLS/public webhook ingress and tunnel durability not verified | HIGH | Platform/SRE | Record TEST ingress, TLS termination, proxy timeouts, allowlists; replace ephemeral tunnel for release |
| W01-03 | Browser session profile persistence, exclusive ownership and recovery unverified | HIGH | Platform/SRE | W02/W06: encrypted durable storage, single-owner enforcement and restart/restore drill |
| W01-04 | Webhook handler waits for business processing (maxDuration 60); retry/lease under proxy timeouts unverified | HIGH | Engineering/QA | W05: measure live duration, retry/lease behavior and duplicate-safe recovery |
| W01-05 | Ambiguous send, media delivery and read-status parity require native evidence | HIGH | Engineering/QA | W05 + OW12/OW13 live scenarios; no blind resend |
| W01-06 | NOTE-001 remains open; current security advisors not refreshed here | HIGH | Security/DB | W03: current advisor inventory, caller/role analysis, TEST negative scope checks |
| W01-07 | No confirmed on-call, dashboard, paging or capacity baseline | HIGH | SRE | W04/W06: metrics, alerts, owner/backup, capacity and backup restore drills |
| W01-08 | No release artifact/migration manifest tied to production deploy | HIGH | Release Engineering | W08: exact SHA, CI, image digest, schema ledger, replay and rollback evidence |
| W01-09 | Formal live OW12 acceptance and OW13 bounded pilot deferred | BLOCKER | QA/Pilot owner | Resume only when authorized; do not waive release gates |
| W01-10 | Consent, product warning and explicit production opt-in not yet approved | HIGH | Product/Legal | W07: opt-in, localized risk warning, admin-only session controls |

Severity is provisional until owners validate deployment facts and security evidence.

## 5. Required follow-up read-only evidence

1. Actual TEST and proposed Production hosting provider, app host/runtime, gateway host and service versions; **no secrets**.
2. DNS records, TLS termination, reverse proxy timeout, firewall ingress/egress and webhook public reachability.
3. OpenWA container/image digest, engine version, session profile volume, supervisor, restart and health status.
4. External scheduler configuration and failure alert route.
5. Current exact-HEAD GitHub Actions completed status and TEST migration ledger/replay.
6. TEST security advisors, NOTE-001 per-object triage, RLS and tenant-isolation negative evidence.
7. Live webhook latency/retry, media/status/reconciliation evidence once deferred tests resume.
8. Named operational owners, backup/restore objectives and evidence links.

## 6. Exit decision

**W01 initial source baseline: documented.** W01 is **not closed**: deployed topology, live dependency inventory, evidence owner review and risk register sign-off remain outstanding. OW14 production decision remains **NO-GO**. This file is a baseline for W02/W03/W04/W06/W08 and must be refreshed when deployment facts are obtained.

No production mutation, credentials, migration, runtime code or live acceptance was performed in this audit.
