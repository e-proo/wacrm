# OW-14 — Production Readiness & Controlled OpenWA Rollout

**Project:** WACRM — WhatsApp Multi-Provider & OpenWA Integration (P-SOF-2)
**Repository:** e-proo/wacrm
**Canonical branch:** refactor/service-platform-v2
**Planning audit:** 2026-11-12; baseline HEAD 3175c541d2a33851593a6ed45042e62ca7186a3c
**Evidence:** CI https://github.com/e-proo/wacrm/actions/runs/43298734037 (success); migration replay https://github.com/e-proo/wacrm/actions/runs/43297752814 (success).
**State:** PREPARATION ONLY / PRODUCTION NO-GO. Refresh HEAD, CI, TEST and security evidence at execution time. The owner deferred remaining live tests; this is not a waiver of any gate.

## 1. Mission, scope and non-negotiable principles

Prepare an explicit, auditable Production GO/NO-GO and a controlled opt-in release plan for OpenWA. Meta Cloud API must remain the official/default production provider. OpenWA is an optional separate self-hosted WhatsApp transport; WACRM alone owns CRM state, agents, flows, automations, broadcasts, policy, idempotency and audit. Outbound provider selection must be scoped to connection.provider; all Meta and OpenWA inbound events meet in the unified WACRM pipeline.

Not permitted: replacing Meta; automatic Meta/OpenWA switching for an existing customer identity; blind resend after ambiguous provider timeout; guessing phone-to-@lid correlation; unscoped service-role operations; plaintext credentials/QR/session profiles in DB/client/logs; parallel OpenWA CRM/automation systems; changes to applied migrations; any Production data, traffic, secrets or infrastructure mutation without separately recorded authorization.

OW-14 preparation can begin before OW-12/13 acceptance. OW-14 Production rollout/approval cannot.

## 2. Current engineering baseline (snapshots, not release evidence)

- OW-0 through OW-11 implementation issues closed historically. OW-12 live TEST / SOF-41 remains In Progress. OW-13 preparation SOF-42 and SOF-44 remains In Progress; SOF-43 formal bounded pilot is Todo/blocked. SOF-45 development trial is not formal pilot acceptance. Upstream startup/recovery SOF-46 and native chat/webhook acceptance SOF-47 require current verification.
- TEST migration 155 and 156 applied, CI and clean replay passed at previous verified commits. This proves schema and source checks, NOT production migration permission.
- TEST latest connection snapshot: one active OpenWA connection (02527740-9806-45ae-b9b1-1354c25f1d3f), DB status ready, pilot_enabled=false, manual_paused=false, zero sending, zero pending webhook receipts. This is a TEST ordinary-send configuration, NOT proof of actual delivery or completed bounded pilot. Previous development pending records were operator-discarded; this does NOT establish native provider outcome reconciliation.
- Project notes NOTE-001 remains open. TEST security advisor: rls_enabled_no_policy 6 INFO (some intentionally server-only), function_search_path_mutable 16 WARN, extension_in_public 1 WARN, anon_security_definer_function_executable 22 WARN, authenticated_security_definer_function_executable 28 WARN, auth_leaked_password_protection 1 WARN. Each needs scoped risk assessment; counts alone do not prove exploitability.
- Real local Next.js Pilot API 404 and intermittent signed webhook 503, archived-session read 409, media/status and restart scenarios require verified resolution where they affect acceptance. A 503 may represent deliberate retry/in-flight processing; not automatically lost delivery.

Sources: 00_MASTER_IMPLEMENTATION_PLAN.md; 05_TEST_PILOT_AND_ROLLOUT.md; 08_OW13_BOUNDED_PILOT_PREPARATION.md; PROJECT_NOTES.md; Linear SOF-41..SOF-47.

## 3. Stage gates and permissions

| Stage | Focus | Work permitted now? | Required exit evidence |
| --- | --- | --- | --- |
| P0 Baseline & design | repository/TEST/CI inventory, design, threat model, gap register | YES, read-only and documentation | reviewed architecture and gaps |
| P1 Readiness engineering | isolated deployment design, observability, security, guarded opt-in, recovery, regression | PLAN NOW; implement later under scoped authorization on development/TEST | implementation complete + exact HEAD CI/TEST verified |
| P2 Deferred acceptance | complete OW-12, formal OW-13 pilot and non-admin tenant negatives | BLOCKED, tests deferred | live acceptance complete and bounded pilot accepted |
| P3 Release decision | independent security/ops/product GO/NO-GO | BLOCKED | signed release decision and immutable evidence manifest |
| P4 Production canary | opt-in dark deployment, internal cohort, staged expansion | BLOCKED | new explicit Production authorization and per-wave approval |
| P5 Stabilization | monitored observation, incidents, closing GA risks | BLOCKED | independent operational/security approval and final production ready decision |

Never convert an implementation checkbox into a live acceptance or production ready claim.

## 4. Detailed work breakdown

### OW14-W01 — Architecture, deployment and dependency baseline (P0)

Inspect actual current source and deployed topology, including WACRM hosting, immutable deployment artifact, environment boundaries, TLS/DNS, separate OpenWA gateway, persistent session data, ingress/firewall, secret store, restart strategy, tunnel dependencies, account/connection provider resolution and Webhook endpoint. Trace current router, adapter, client, credentials, session lifecycle, send/status, signed webhook and guardrails; document gaps against production assumptions. Do not assume Windows local development or rotating Quick Tunnel is durable production infrastructure.

**DoD:** versioned topology and dependencies diagram; current files/endpoints/config references; gap/risk register with proposed owners, impact, mitigation, evidence status and intended test.

### OW14-W02 — Isolated self-hosted gateway and release artifacts (P1)

Design OpenWA as a separately deployed, authenticated REST service. Pin verified image/source tag, dependency lock, Chromium/session engine compatibility and artifact digest; configure least-privilege user, durable encrypted auth profiles, exclusive session ownership, health checks, supervisor/restart policies, private networking, TLS, bounded outbound traffic and network ACL. Use reproducible infrastructure-as-code without embedded credentials. Avoid tunnel URLs that rotate or redirect. No copy of OpenWA internals into Next.js. Define image rollback compatibility: browser profile version upgrade may not be safely reversible without backup.

**DoD:** deployment manifests/design, artifact provenance, environment parity, tested TEST deploy/upgrade/restore, security-reviewed networking, operational owner and rollback steps. Production deploy remains separately gated.

### OW14-W03 — Security, Supabase NOTE-001, privacy and secret rotation (P0/P1)

Review each Supabase advisor finding by table/function, runtime caller, role/RLS grants, exposure, severity and remediation or authorized exception. Do not blanket-grant roles or weaken RLS to make tests pass. Add new migrations for schema/security changes; applied migrations immutable. Review cross-tenant access through service-role; session admin QR exposure; signed webhook HMAC, replay protection and dedup; URL validation and SSRF; provider session credential encryption; logging redaction; leaked-password protection; data retention. Design and rehearse API/HMAC/encryption key rotation with overlap, revocation, read-only verification and audit, never plaintext secrets in GitHub/Linear.

**DoD:** threat model, current advisor triage, explicit NOTE-001 decision (fix or separately approved time-bound risk exception), tenant/RLS negative tests, secret rotation runbook and evidence signed by security owner. Any unresolved exploitable Critical/High = NO-GO.

### OW14-W04 — Observability, alerts and on-call / incident ownership (P0/P1)

Define redacted metrics scoped to tenant and connection: session ready intervals/disconnects/reconnects/restrictions, gateway HTTP errors and latency, signed inbound 202/200/401/503, webhook leases/retries, queue age, sent/delivered/read delays, ambiguous send and reconciliation, duplicate rate, media errors, WACRM guardrail denials/circuit, agent/automation/broadcast workload, Meta regression, host CPU/RAM/disk/browser processes. No phone/JID/body/secret/QR in labels or logs. Define dashboards, paging route, business hours, on-call owner/backup and operational drill.

**DoD:** reviewable dashboards/queries, safe event schemas, alert definitions, synthetic alert delivery and incident playbook. Immediate STOP for cross-tenant leak, confirmed physical duplicate, credential leak or restriction. Other thresholds are PROPOSALS to calibrate from the actual OW-13 pilot, not preapproved SLOs.

### OW14-W05 — Delivery reliability, webhook, media and reconciliation (P1/P2)

Audit the actual REST and signed-webhook code paths: long-running AI inbound processing, 503 in-flight/retry semantics, receipt leases, dedup, eventual provider redelivery, failure/restart behavior, safe ACK. Introduce durable queue/worker separation only if the evidence requires it, preserving unified WACRM business policy. Verify image/video/audio/document relay and native delivery/read statuses. Define provider-native correlation for uncertain sends or require explicit operator hold when native lookup is unavailable; NEVER infer failure from timeout, automatically resend or manufacture provider IDs.

**DoD:** current-HEAD regression tests, TEST+provider proof after testing resumes, bounded resource/retry experiments, no duplicate physical sends, no unreconciled sends in approved cohort, live Meta parity. Implementation alone is not OW-12 live acceptance.

### OW14-W06 — Capacity, scaling, backup and restore (P0/P1)

Inventory per-session engine/browser memory, CPU, network, storage/media spool, webhook concurrency, instance/session density and cost. Design bounded scaling and placement by tenant/number, no incompatible co-resident sessions, failure-domain limits and privacy-conscious telemetry. Define RTO/RPO as TARGETS TO APPROVE, never claimed measured until a restore drill. Backup encrypted OpenWA session profiles, WACRM state, keys and configuration; test loss of gateway host, tunnel, session auth, database connectivity and reconnection. Operator-owned re-QR process when recovery cannot restore linked-device state.

**DoD:** capacity model with measurements and assumptions, backup retention/encryption, restore drill results and verified rollback compatibility.

### OW14-W07 — Product choice, consent, feature flags and customer support (P0/P1)

Create customer-facing Arabic/English copy accurately warning OpenWA is an unofficial WhatsApp Web linked-device integration with connection, reliability, account-policy and re-authentication risks. Get explicit opt-in and any necessary consent, legal/product approval, support and incident escalation policy. Keep Meta default; no automatic failover, no unapproved bulk broadcast. Define production-scoped per-account/connection/workload opt-in independently of the pinned TEST-only pilot_enabled override. Ensure admins own QR/session controls, never agents.

**DoD:** approved legal/product terms, localized UI/permission/feature-flag contract, no-openwa-by-default tests, opt-in audit and support playbook.

### OW14-W08 — Release engineering, CI/migration and testing contract (P1/P2)

Produce pinned release manifest: repository SHA, commit/image digest, environment variables names (never values), migration ledger/version/hash, clean replay, rollback compatibility, workflows and owner approvals. Require lint, typecheck, full Vitest, build, Meta regression, openwa/media/reply, idempotency/negative scope tests, secret scan, TEST schema/RLS smokes and complete live OW-12/OW-13 matrix. Recheck CI ACTUAL completed/success for latest final release SHA. Schema changes additive; Production migration requires its own risk review, backup and authorization.

**DoD:** reviewed release candidate, exact SHA/CI/replay logs and explicitly completed TEST acceptance. Queued/in_progress workflows are never green gates.

### OW14-W09 — Independent Go/No-Go / decision packet (P3, BLOCKED)

Collect evidence G0..G8 in 11_OW14_RELEASE_DECISION_TEMPLATE.md. Each check gets PASS/FAIL/PENDING/N/A (N/A justified), owner, date and immutable evidence link. Named approvals from engineering, security, operations, release owner and product/legal. Conditional approval may authorize a non-production rehearsal but DOES NOT authorize customer-facing production changes. Current gate decision MUST remain NO-GO because OW-12, OW-13 and NOTE-001 are open.

**DoD:** signed GO/NO-GO decision with enumerated accepted risks and explicit conditions. No green CI alone constitutes authorization.

### OW14-W10 — Staged Production rollout, immediate stop and stabilization (P4/P5, BLOCKED)

Only after formal GO and separate Production change authorization. Proposed (not approved) waves: R0 deploy dark, zero OpenWA sends; R1 one internal consenting tenant/number; R2 small opted-in low-risk tenants; R3 cautious expansion. Each wave requires approved identities, start/end window, quotas, monitoring/on-call owner, no unresolved incidents and fresh approval before expansion. Never switch existing Meta customers without a separately justified consent/identity contract.

**STOP:** tenant leak/credential leak, physical duplicates, account restriction, uncontrolled reconnect, persistent webhook failure, missing telemetry, abnormal ambiguous sends or Meta regression. Pause affected OpenWA connection/cohort, suspend matching WACRM automation/broadcast/agent triggers, preserve audit/native IDs, do not delete session profiles or resend uncertain messages. Rollback application/image only with tested compatibility and observe Meta separately.

**DoD:** per-wave logs/metrics, stop/rollback drills, stabilization report, incident disposition and final independent production ready approval.

## 5. Evidence/decision matrix

| Gate | Proof required | Owner role | Initial |
| --- | --- | --- | --- |
| G0 current source | HEAD + exact CI + clean migration replay | Engineering | Recheck at release |
| G1 OW-12 | SOF-41 complete live provider tests incl Meta | QA | PENDING |
| G2 OW-13 | SOF-43 approved bounded pilot report | Pilot owner | PENDING |
| G3 reliable infrastructure | W01/W02/W06 topology and restore proof | SRE | PENDING |
| G4 security/privacy | W03 NOTE-001 decision, rights/isolation, secrets | Security | PENDING |
| G5 alerts/on-call | W04 monitoring, owner and incident drill | SRE | PENDING |
| G6 messaging parity | W05/W08 current TEST+CI/Meta evidence | Engineering/QA | PENDING |
| G7 customer warning | W07 consent/product/legal approval | Product/Legal | PENDING |
| G8 signed release GO | W09 owners and dated decision | Release owner | NO-GO |
| G9 controlled canary | W10 production waves after authorization | Release owner | NOT STARTED |

**Final Definition of Done:** OW-14 can be marked production ready only after ALL applicable G0..G9 pass and required rollout/security approvals are recorded. Subtasks may be preparation complete or implementation complete earlier; this never closes the phase.

## 6. Execution order and handoff

1. NOW: draft and review W01 baseline; W02 topology; W03 threat model/NOTE-001 inventory; W04 telemetry spec; W06 capacity model; W07 warning/consent; W08 manifest and W09 decision template. Create separately tracked issues in existing OW-14 Linear milestone. No Production edits or test-gate waivers.
2. On a later separately scoped development authorization, implement missing readiness controls incrementally on refactor/service-platform-v2, with CI/TEST verification and additive migrations only.
3. When live testing is resumed by owner, complete SOF-41, SOF-44, SOF-46/47 and formal SOF-43, measure evidence and update risk register.
4. Independent release/security/operations review of evidence; record GO/NO-GO. No implicit production approval from plan completion.
5. If approved explicitly: dark deploy -> internal opt-in -> bounded customer cohort -> expansion, with stop and rollback after every gate. Record stabilization separately.

**First recommended implementation ticket:** W01 — read-only production topology and source-to-deployment gap audit. It determines correct infrastructure and avoids premature production changes.

## 7. Ownership and change control

Proposed roles: Engineering (W01/W05/W08), SRE/Platform (W02/W04/W06/W10), Security/DB (W03), Product/Legal/Support (W07), QA/Pilot owner (G1/G2), independent Release Owner (W09/W10). Specific humans, deputies and estimated dates are TBD; do not invent approvals. Store only redacted evidence, never secrets or sensitive recipient identities. Every later Production change needs a separate approved change ticket, backup/checkpoint, window, stop owner and rollback evidence.

References: 00_MASTER_IMPLEMENTATION_PLAN.md, 05_TEST_PILOT_AND_ROLLOUT.md, 08_OW13_BOUNDED_PILOT_PREPARATION.md and 11_OW14_RELEASE_DECISION_TEMPLATE.md.
