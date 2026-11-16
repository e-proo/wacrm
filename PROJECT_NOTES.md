# Project Notes Backlog

This file is the canonical place for important findings that are **outside the scope of the currently executing implementation plan** but must not be forgotten.

## How to use this file

- Add a new entry whenever work uncovers a meaningful issue, risk, debt item, or follow-up that is intentionally deferred because it is outside the active plan.
- Do not silently fix an item from this file as part of an unrelated phase; move it into an explicit plan first.
- When an item is resolved, keep the entry and mark it `resolved` with the resolving commit/migration/plan reference.
- Prefer concrete evidence, affected surfaces, and a clear reason for deferral.

## Open notes

### NOTE-001 — Supabase project-wide security advisor findings

- **Status:** open / deferred
- **Discovered during:** FX V2 Phase 5 closure
- **Scope:** project-wide Supabase hardening, not FX V2 Phase 5
- **Summary:** The Supabase Security Advisor still reports pre-existing security findings, including multiple `SECURITY DEFINER` functions executable by `anon` and/or `authenticated`, functions with mutable or unset `search_path`, two RLS-enabled tables with no policies, the `vector` extension in `public`, and leaked-password protection being disabled.
- **Important context:** Migrations `082_fx_v2_admin_agent_tools.sql` and `083_fx_v2_admin_grant_plane_cleanup.sql` did not introduce these findings. Phase 5 only remapped/cleaned frozen AI tool-grant rows.
- **Why deferred:** Resolving these warnings safely requires a dedicated project-wide security-hardening plan because several functions are shared infrastructure and changing grants/search paths can affect existing application flows.
- **Return-to-work criteria:** Create an explicit Supabase security-hardening plan, inventory each advisor finding against runtime callers, classify intentional vs unsafe exposure, patch incrementally on TEST/STAGING, then rerun advisors and full CI/E2E before production consideration.
- **Recheck — 2026-10-07 after Service Platform Phase 5 closure:** current TEST advisor counts are: `rls_enabled_no_policy=1`, `function_search_path_mutable=16`, `extension_in_public=1`, `anon_security_definer_function_executable=22`, `authenticated_security_definer_function_executable=28`, and `auth_leaked_password_protection=1`. This supersedes the older count wording in the summary but does not change the deferred classification.
- **Phase 5 relevance check:** no current advisor finding was named against `claim_customer_*`, `business_event_*`, or `customer_intent_notifications`; the Phase 5 contraction did not introduce a newly identified advisor exposure.
- **Advisor references:** https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy ; https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable ; https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable ; https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable

### NOTE-002 — Meta/Instagram restriction blocked Intents WhatsApp Gate C

- **Status:** resolved — 2026-10-06
- **Recorded:** 2026-09-27
- **Resolved:** 2026-10-06
- **Discovered during:** Service Platform V2 Phase 1 — Intents active WhatsApp E2E
- **Scope:** Meta account/app availability; the original failure was external to Intents, Business Events, and Supabase cutover contracts.
- **Historical blocker:** phone metadata and WABA `subscribed_apps` checks returned `HTTP 400 / API access blocked`, and new inbound messages were not reaching the application at the pause checkpoint.
- **Resolution evidence:** after external access was restored sufficiently for live testing, Gate C completed successfully through `business_event_outbox → projector/template → engineSendText → Meta`. The canonical `service_request.approved` event and its strangler-linked legacy row both reached `sent` with the same `local_message_id`, and the replay check produced no duplicate.
- **Gate D evidence:** guarded rollback completed successfully; post-rollback verification showed zero active/legacy nonterminal rows and no `sending` or `requires_reconciliation`.
- **Final TEST state:** route `service_request_customer_whatsapp` was reactivated; `mode=active`, `ready=true`, `blockers=0`, parity `4/4`, `active_nonterminal=0`, `legacy_nonterminal=0`.
- **Code verification:** CI for the Gate C/D hardening passed lint, typecheck, test, and build.
- **Follow-up:** Phase 1 is COMPLETE. Phase 5 legacy contraction may proceed under its own safeguards; this resolved note remains as historical evidence for why the earlier pause was correct.
### NOTE-003 — Service Platform rollback compatibility retirement window

- **Status:** open / intentionally deferred
- **Discovered during:** Service Platform V2 Phase 5 closure
- **Scope:** post-cutover compatibility retirement; not required to reopen Phase 5.
- **Summary:** The new customer delivery source of truth is `business_event_outbox` for covered active routes, but several historical/rollback surfaces intentionally remain: `customer_intent_notifications`, `claim_customer_business_notifications`, `renderLinkedLegacyBusinessEventNotification`, readiness/rollback/reconciliation helpers, and the schema-only `claim_customer_intent_notifications` RPC.
- **Current runtime fact:** `claim_customer_intent_notifications` has no current runtime consumer; contract tests explicitly prevent reintroducing that call. The RPC remains only for backward compatibility with older binaries.
- **Why deferred:** The transition plan explicitly forbids deleting the rollback path in the same cutover phase. Historical terminal rows also remain and some rollback/readiness helpers still depend on the compatibility table.
- **Safety state on TEST at Phase 5 closure:** FX/Coverage/Intents routes are active with legacy notification writes disabled; there are no `pending`, `sending`, or `requires_reconciliation` rows in `customer_intent_notifications`.
- **Return-to-work criteria:** explicitly end the rollback compatibility window, inventory every remaining DB/runtime consumer, decide support for rollback to older binaries, define archival/retention handling for historical rows, then perform any schema removal through a new append-only migration with clean replay, security checks, rollback plan, and live TEST acceptance.

### NOTE-004 — Agent Task authenticated RLS smoke blocks branch-wide Migrations green state

- **Status:** resolved — 2026-10-07
- **Discovered during:** Service Platform V2 Phase 5 final verification / Phase 6 preparation.
- **Scope:** AI Agent Task Platform security acceptance, not Service Platform legacy contraction.
- **Original evidence:** Migrations run `37551887552` failed only at `agent-task-rls-smoke.sql` with `permission denied for table ai_agent_runs`.
- **Root cause:** `046_ai_routing_runs.sql` created the intended RLS policies but did not explicitly normalize table grants. Clean replay no longer inherited the historical Data API grants required for authenticated access, so PostgreSQL rejected the query before RLS evaluation.
- **Historical TEST drift found:** before remediation, long-lived TEST still exposed SELECT/INSERT/UPDATE/DELETE table privileges to `anon` and `authenticated` on `ai_agent_runs` and `ai_agent_run_events`, which was wider than the documented runtime contract.
- **Official additive migration:** generated with pinned Supabase CLI `2.113.0` through one-shot Actions run `37554911701`: `supabase/migrations/20261007010039_ai_agent_run_acl_hardening.sql`.
- **Final ACL:** `ai_agent_runs` gives authenticated SELECT+UPDATE only and no anon access; `ai_agent_run_events` gives authenticated SELECT only and no anon/client writes; service_role retains service operations.
- **Regression coverage:** `supabase/ci/agent-task-rls-smoke.sql` now asserts table privileges before exercising owner/cross-tenant RLS.
- **Clean DB proof:** Migrations run `37555338146` = SUCCESS, including clean replay, schema verification, every Service Platform/Agent Task smoke, and the final authenticated RLS isolation test.
- **Application CI proof:** run `37555338255` = SUCCESS with lint/typecheck/test/build all green.
- **TEST deployment:** migration applied successfully to `wacrm test`; remote migration history records `20261007010743 ai_agent_run_acl_hardening`.
- **Live TEST proof:** authenticated owner reads for Agent Runs/Run Events succeed through RLS; forbidden client privileges and all anon table privileges are absent.
- **Advisor recheck:** no new Security Advisor finding targets `ai_agent_runs` or `ai_agent_run_events`. Existing project-wide findings remain tracked under `NOTE-001`.
- **Resolution:** Phase 6 Gate B is PASS. No further work is required under NOTE-004 unless the ACL contract intentionally changes later.

### NOTE-005 — Transient Next.js `next/font` build failure during Phase 5 closure

- **Status:** resolved / observation retained
- **Discovered during:** Service Platform V2 Phase 5 closure
- **Scope:** CI/build environment observation.
- **Evidence of failure:** CI run `37552262468` passed lint, typecheck, and tests, then `next build --webpack` failed in `next/font` with `TypeError: Cannot read properties of null (reading '1')`.
- **Resolution evidence:** the final Phase 5 head CI run `37552511616` subsequently passed lint, typecheck, tests, and build without a source fix specifically for `next/font`.
- **Conclusion:** treat the earlier failure as transient unless it recurs. It is not a current Phase 6 blocker.
- **Return-to-work criteria if it recurs:** inspect the exact Next.js version documentation under `node_modules/next/dist/docs/` per `AGENTS.md`, capture reproducibility/environment differences, and fix only after confirming a deterministic project issue.

### NOTE-006 — Transition branch diverged from rollback baseline

- **Status:** resolved as a missing-content risk / retain final-head recheck
- **Discovered during:** Service Platform V2 Phase 6 preparation
- **Scope:** branch integration and rollback safety.
- **Branches:** transition = `refactor/service-platform-v2`; rollback baseline = `test/ai-runtime-kb-tools-v2`.
- **Initial comparison snapshot — 2026-10-07:** GitHub reported `diverged`; transition branch was `680` commits ahead and `8` commits behind the rollback baseline. Compared baseline head: `99e070c54a3f024d7e596fa789ffeab424c74f6f`; merge base: `4a80fb72709dcaffa4b3d1b5d51358b1cdaf8a76`.
- **Inventory result:** the eight baseline-only commits are four FX changes followed by four rollback/restoration commits:
  - `2b4712e5` — suppress stale lifecycle notifications.
  - `e142bd9a` — share lifecycle event renderer in worker.
  - `1f42c32d` — migrate canonical lifecycle events safely.
  - `13858d9b` — add canonical event recovery/supersession coverage.
  - `9ea1a301` — restore `fx-v2-outbox.ts` baseline.
  - `430520b6` — restore `worker.ts` baseline.
  - `2c657c40` — restore migration `089_fx_trade_canonical_business_events.sql` baseline.
  - `99e070c5` — restore `fx-business-event-delivery-contract.test.ts` baseline.
- **Net-tree verification:** comparing merge base `4a80fb72...` to rollback baseline head `99e070c5...` returns `files=[]`. Therefore the eight commits leave no net content delta that must be ported into the transition branch.
- **Conclusion:** there is no currently missing rollback-baseline fix hidden by the commit-graph divergence. The transition branch may remain graph-diverged without requiring those eight commits to be cherry-picked.
- **Final Phase 6 safeguard:** repeat the compare on the final acceptance head before any merge/rebase/release decision; if baseline changes later, classify any new baseline-only content before proceeding.

### NOTE-007 — OW-4 live OpenWA TEST session/QR acceptance deferred

- **Status:** resolved — 2026-11-07; OW-4 implementation + live TEST session/QR + CI/Meta regression gate verified at merge HEAD `c87fd13c`
- **Recorded:** 2026-10-25
- **Discovered during:** OpenWA OW-4 closure
- **Scope:** live TEST acceptance for OpenWA session lifecycle and QR onboarding; implementation itself is complete.
- **Implementation evidence:** OW-4 implementation HEAD `ccb421426bf8e3dcc305db3a2ad5faaba6230711`; GitHub CI #822 / run `40031691828` completed successfully with lint, typecheck, tests and build green.
- **Historical TEST evidence at deferral (2026-10-25):** `wacrm test` had no `openwa` connection and no OpenWA credential record, so a real session/QR proof could not be produced then. Superseded by the 2026-11-07 live checkpoint below.
- **External dependency:** a reachable non-production OpenWA service plus server-side API credential is required to execute the live session creation and short-lived QR acceptance scenario.
- **Safety constraints at original deferral (historical):** OW-4 could not be considered `TEST verified` without real QR/session evidence. That acceptance has since occurred; it does not authorize production enablement. OpenWA outbound routing was subsequently implemented in OW-7 under its separate gate; OW-12 live acceptance remains partial.
- **Return-to-work criteria:** provision/configure a reachable TEST OpenWA endpoint and server-side credential, create an account-scoped non-production OpenWA connection, verify authorized-admin QR display with no-store/expiry behavior, record the evidence, then mark the OW-4 TEST acceptance gate satisfied.
- **Live checkpoint — 2026-11-07:** Real local OpenWA connected to WACRM via separate HTTPS Cloudflare tunnels; WACRM connection create 201, QR 200, authorized UI Ready; current TEST has two `openwa/ready` sessions and Meta still connected. Code confirms admin/tenant-scoped no-store, <=60s QR endpoint. The original missing external provider proof is now satisfied for this OW-4 happy path.
- **Resolution evidence (2026-11-07):** [PR #3](https://github.com/e-proo/wacrm/pull/3) merged into `refactor/service-platform-v2` at `c87fd13cf68df1cc6757fd910a7761e9110ff411`. [CI #42410328689](https://github.com/e-proo/wacrm/actions/runs/42410328689) and [Migrations #42410328723](https://github.com/e-proo/wacrm/actions/runs/42410328723) were both `completed/success` on the merge commit, covering the dedicated OW-4 session/QR + Meta regression tests, full lint/typecheck/tests/build, clean schema replay and OW-4 credential/tenant/RLS smoke. Additive migration `152_openwa_service_role_credential_grants.sql` was applied on TEST; server-side access and denial of client read privilege were verified. The original NOTE-007 blocker is **resolved**. The historical ambiguous `sending` row and remaining media/restart/reconciliation/automation/broadcast/tenant/live Meta scenarios belong to OW-12, not this OW-4 closure. NOTE-001 remains open for eventual production approval; **not production ready**.

### NOTE-008 — TEST OpenWA Pilot Stop is not Disable

- **Status (2026-11-12):** implementation prepared; CI, clean migration replay, remote TEST migration and live acceptance must be verified separately before claiming closure.
- **Symptom:** stopping an OW-13 TEST Pilot session pauses all sends and revokes its recipient grants. Since TEST enforcement remained enabled regardless of `OPENWA_PILOT_MODE=off`, subsequent sends were denied with `OpenWA pilot cohort does not authorize this send`.
- **Change:** additive migration `156_openwa_test_pilot_mode_toggle.sql` adds per-connection `whatsapp_connection_guardrails.pilot_enabled` (default `true`) and a service-only transactional `set_openwa_test_pilot_mode` RPC with a `whatsapp_openwa_pilot_mode_events` actor audit ledger. Admin Settings now has a separate **Disable Pilot and allow normal sending / Enable Pilot** control for the selected TEST session. Ordinary emergency **Stop** remains independent.
- **Scope/safety:** the override is honored by the OpenWA transport **only** when connected to the pinned TEST Supabase project. Production and other environments continue following their existing `OPENWA_PILOT_MODE` configuration. Mode disable requires explicit confirmation, a provider-ready session, zero unsettled outbound sends, and explicit duplicate-session review. The SQL transaction rechecks account/connection and blocks cross-tenant use. Existing anti-abuse capacity, circuit breaker, reconciliation, and provider identity checks remain in force; normal mode restores OW-10 limits instead of removing safety controls.
- **Rollback:** disable Pilot does not require code rollback; choosing **Enable Pilot** pauses sending, revokes stale approvals, and requires fresh TEST admission. To roll back the runtime without reverting an applied migration, leave all `pilot_enabled` flags set to `true` and run previous code. Do not edit migration 156 after application.
- **Separate symptoms:** `OpenWA connection is not configured for this account`, `openwa/read 409`, and signed webhook `503` are distinct connection/identity/read-ack/webhook-retry paths; this Pilot mode switch is not a fix for those failures.


### NOTE-009 — OpenWA gateway URL vs WACRM signed webhook URL (TEST)

- **Discovered:** 2026-11-13. Changing OpenWA gateway base URL and API key in the WACRM connection editor updates the WACRM -> OpenWA REST client, not the reverse OpenWA -> WACRM webhook registration.
- **Fix (source):** The per-session admin editor now includes a separate WACRM callback URL ending in `/api/whatsapp/openwa/webhook`. A TEST-scoped, authorized `configure_webhook` action verifies provider registration after PUT/POST and stores `webhook_url` in the existing server-only encrypted credential table (additive migration 157). A new OpenWA callback replaces a unique existing WACRM callback by **webhook ID**; it does not create a parallel duplicate. Multiple existing WACRM callbacks are an operator reconciliation blocker rather than grounds for blind deletion.
- **Safety:** The existing HMAC secret remains encrypted and is reused. Credentials remain account/connection scoped. The new URL is a non-secret callback setting but is stored server-only; RLS/denied browser grants are preserved. Production webhook URL customization remains blocked; Meta and Pilot routing remain unchanged. No remote OpenWA session is created or message resent during settings changes.
- **TEST:** Schema change `openwa_connection_webhook_url` applied to the TEST Supabase project on 2026-11-13; verified column present, RLS enabled, anon/authenticated SELECT denied, service role UPDATE enabled. Clean replay includes `supabase/ci/openwa-session-webhook-smoke.sql`.
- **Remaining acceptance:** Running local WACRM must pull the new branch. User must supply the current WACRM public HTTPS callback URL in the **session settings** dialog, save, and verify the OpenWA Webhooks dashboard displays exactly one current WACRM URL. Duplicate legacy registrations require manual review. CI / live upstream confirmation must be tracked separately, and nothing here confers production readiness.

### NOTE-010 — Admin Agent as a task planning and delegation manager (post-open-phases)

- **Status:** proposed / intentionally deferred. **Recorded:** 2026-11-15.
- **Trigger:** Operator wants to instruct a verified admin agent through WhatsApp in natural Arabic: “تابع مديونيات هؤلاء العملاء”, “نحتاج 500 ألف تغطية في صنعاء ولدينا طلب بالمكلا”, or “اسأل العملاء المحددين عن احتياجهم للحوالات”.
- **Why deferred:** Finish open Agent Task phases (especially Phase 17 testing, Phase 18 TEST cutover, Phase 19 bounded Coverage pilot), SOF-66 multi-recipient TEST live acceptance, and relevant OpenWA acceptance before expanding task creation authority. No automatic activation or outbound sending is authorized by this note.
- **What exists:** trusted-admin WhatsApp routing, admin read/proposal/approval tools, registered `coverage.sourcing@1/@2` and `services.promotion@1` task modules, deterministic task triggers, targeted WhatsApp outbound/replies/correlation, and exact 1–20 CRM recipient selection for Coverage. The current admin agent is **not** a generic natural-language task creator/dispatcher; `fx.outreach` and `receivables.followup` are **not** registered Task Types.
- **Proposed design:** extend the **existing** Agent Task Platform with a server-authoritative Admin Task Planner (`READ -> typed draft -> explicit human approval -> deterministic task creator -> registered agent/immutable revision -> Task Targets -> WhatsApp -> reporting`). Keep agent model output out of account ownership, audience selection, capability grants, queue control, and provider/session credentials.
- **Future Task Types:** FX transfer interest follow-up (`fx.outreach`, without promising settlement or fabricated rates); receivables/debt payment reminders (`receivables.followup`, only after verified debt ledger/source exists, respectful messages, dispute handling and no automatic ledger changes); multi-request Coverage sourcing. Each needs a domain-owned target resolver/message policy, consent & suppression, frozen target set, schedule/caps, approvals, outcome observation, audit/idempotency/rollback, and TEST E2E.
- **Acceptance:** a verified administrator can propose a task via WhatsApp, inspect exact recipients, approve or reject, confirm the correct outbound session, see per-number replies/skip reasons/remaining balance, pause/stop, and obtain a reliable status summary. Wrong tenant, unauthorized admin, wrong domain, unconsented recipients, duplicate/replayed commands, ambiguous sends, or unavailable channel fail closed. No provider secrets exposed.
- **Next step after open phases close:** create an explicit implementation plan + Linear implementation issues and phase gates, then implement incrementally with CI/TEST. NOTE-001 security debt remains separate and blocks production readiness.
- **Tracking:** Linear **SOF-67** (Backlog), explicitly blocked by SOF-22, SOF-23, SOF-24 and SOF-66.

### NOTE-011 — Bounded OpenWA multi-recipient TEST cohort (SOF-66 / OW-13)

- **Status:** implementation under CI/TEST acceptance (2026-11-15), NOT permission to send.
- **Scope:** CRM Contact selection or manually entered normalized phone input in an authorized OpenWA TEST Pilot UI; choose 1–10 explicitly approved recipients as an atomic cohort for either `manual` or `agent`. Historically `agent` approvals required verified 24-hour inbound on the exact TEST session. The optional operator-attested **phone-call WhatsApp opt-in** route added by migration 166 supersedes that requirement for explicitly approved TEST recipients; see NOTE-012. Pilot session still pauses and stops, and cross-session/tenant approval remains denied.
- **Limits:** `165_openwa_pilot_bounded_workload_limits.sql` (additive) introduced nullable, TEST-only, per-workload cap columns and a service-role-only atomic reservation RPC. Its historical 10/hour and 30/day editable maxima were expanded by additive migration **167** to 100/hour and 1000/day on TEST (see NOTE-013); shared session caps still apply, first-touch remains <=10/day and pacing >=15s. The UI does NOT expose unlimited sending. Normal/Production route behavior remains on its previous reservation RPC.
- **Security:** only hashed recipient identities in the approval ledger; no plaintext credentials in client; no sends during approval; opt-out, account/task policies, anti-abuse, single-recipient historical workflow compatibility and explicit Pilot activation remain effective. Raw manual numbers require operator-asserted consent. Agent first-touch is permitted only for exact scoped TEST recipients with explicit phone-call WhatsApp opt-in, short-lived consent grant, administrator approval and full send guardrails; arbitrary unapproved Agent first-touch fails closed. No production mutation.
- **Acceptance:** CI, Migrations clean replay and new smoke; TEST migration applied; TEST UI chooses CRM and raw manual numbers; two or three verified-inbound or phone-call WhatsApp-consented Agent recipients are approved on one session; bounded multi-target Task dispatch/reply/dedup/reconciliation/Stop tested separately. NOTE-001 production gate still open.

### NOTE-012 — OpenWA Agent TEST telephone WhatsApp opt-in, no inbound prerequisite

- **Recorded:** 2026-11-15. **Scope:** SOF-66, Agent Task Worker and OW-13 TEST Pilot. Existing strict 24-hour inbound rule caused `Missing recent verified Agent chat` for prospective customers previously contacted by telephone.
- **Decision:** Verified inbound is one valid basis for Agent approval, not the only basis. An administrator can explicitly attest each recipient consented **to WhatsApp messages** during a telephone call; merely having called a person is not consent. A distinct `phone_call` grant is account-, session-, recipient-, workload- and expiry-scoped. No free-form Meta Cloud policy is changed.
- **Implementation:** `166_openwa_agent_phone_call_consent.sql` (additive) adds `consent_basis` and `consent_attested_at` to hashed OpenWA Pilot grants; four existing Agent Task SQL reserve/claim gates use a narrowly scoped helper only for OpenWA and active phone-call consent. Pilot UI/API verifies explicit attestation; Task Worker preclaim accepts these grants without a recent inbound, while default verified-inbound grants still require it.
- **New numbers:** the TEST Task picker accepts a directly entered phone with per-contact WhatsApp opt-in attestation, validates active Coverage request + account-scoped OpenWA connection, and auto-creates/reuses an ordinary CRM contact internally (never a parallel task/identity store). This step does not approve the recipient in Pilot or send anything. Existing account/opt-out/suppression/budget/idempotency/ambiguous-result safeguards remain mandatory.
- **TEST evidence:** migration applied on TEST; verified column availability, `anon`/`authenticated` denied execute on `openwa_agent_phone_call_authorized`, `service_role` execute granted, foreign identities denied, and all four DB outbound gates reference the helper. GitHub Migrations clean replay run `43728188703` completed/success. **Full current-HEAD CI and live 2–3-recipient acceptance remain separate requirements**, not a production-readiness claim.
- **Operational safety:** do not auto-start a stopped OpenWA session or enable a recipient grant. Approval alone never sends. With live worker active, activating a session can send already queued approved tasks; operator must review those tasks and exact numbers first. `NOTE-001` security debt remains open.

### NOTE-013 — OpenWA TEST Pilot configurable ceiling 100/hour, 1000/day (2026-11-15)

- **Scope/decision:** Raise the *admin-editable upper bound* for one OpenWA **TEST** Pilot connection and its `agent`/`manual` workloads from 10/hour, 30/day to **100/hour, 1000/day**. This is a configuration ceiling, **not** an automatic default, approved cohort expansion, or authorization to dispatch bulk WhatsApp messages. The safe `prepare` defaults remain 3/hour, 10/day, one new first-touch/day. Each workload's saved cap must not exceed the shared connection cap.
- **Code/schema:** `src/lib/whatsapp/transport/openwa/pilot-cohort-caps.ts` publishes the bounded ceiling, Pilot API validates it and the admin UI offers it. New additive `supabase/migrations/167_openwa_test_pilot_extended_caps.sql` replaces only the four 165 CHECK constraints for nullable workload limits. Existing 149 shared-cap CHECK constraints already support these numbers. Neither `reserve_openwa_pilot_workload_send` nor Production's `reserve_openwa_guardrail_send` is modified; per-session accounting, warmup, pause/circuit, hashed allowlists, consent, first-touch <=10/day, >=15s spacing, and provider reconciliation remain in effect.
- **Safe operator workflow:** While Pilot is paused with **zero active grants**, choose and save desired 1–100 hourly and 1–1000 daily limits and matching workload caps. Changes are rejected during active grants. Stop first only after reviewing in-flight/ambiguous messages: Stop revokes previous grants. Re-approve exact consented numbers; do **not** auto-activate. A capacity ceiling of 1000 does not imply permission to contact 1000 unknown/new people.
- **TEST evidence:** clean migration replay [run 43735129062](https://github.com/e-proo/wacrm/actions/runs/43735129062) completed/success; 167 applied to TEST via remote migration API, with all four constraints verified at 100/1000 and migration history recorded. **Full latest-HEAD CI and live delivery acceptance remain independently required**. No active Pilot caps, grants, session state or message traffic were changed by this engineering operation. NOTE-001 Production security debt remains open.

### NOTE-014 — OpenWA TEST Pilot dynamic cohort admission capacity (2026-11-16)

- **Reason:** the previous approval checker compared every cap only to the recipient count. E.g., three approved contacts with 3 messages planned each incorrectly passed a 3/hour limit; the UI misleadingly displayed a fixed “3 recipients” deficit. Operator requests dynamic **N selected contacts × M planned messages/contact**, not a hardcoded threshold.
- **Scope:** `pilot-cohort-caps.ts`, admin Pilot API, and Pilot controls UI now check shared session, warmup, and selected workload hourly/daily limits against N×M. `first_touch_daily_cap` checks **N new contacts** only; it is not multiplied by messages. M is an explicit admin-editable planning value, default **3** on new batch approvals, bounded so N×M <=100/hour. Suggestions fill but do not persist settings. Existing 100/hour and 1000/day settings are never reset.
- **Persistence:** additive migration `168_openwa_pilot_cohort_message_capacity.sql` adds `whatsapp_openwa_pilot_allowlist.messages_per_recipient` with CHECK 1..100 and legacy default **1** (no retroactive increase). New `grant_batch` persists the chosen M on each exact, scoped, short-lived grant; activation rechecks N×M before and after provider-native readiness verification. Legacy single-grant uses 1. This is **aggregate planned capacity**, not a guarantee of M sends to each contact or permission to re-contact unconsented users.
- **Security/operation:** Existing TEST-specific authentication, opt-in, account scope, pause/stop, 10-recipient max, first-touch, 15s pacing, idempotency, provider reconciliation, and normal Production routing remain intact. Neither migration nor commits amend running sessions, grants, configured limits, or send messages. Existing 3 TEST grants remain active with M=1, preserving historical approvals.
- **2026-11-16 field discrepancy:** the operator observed 3/hour and 10/day despite a prior 100/hour and 1000/day TEST amendment. Actual TEST audit showed Pilot was disabled and re-enabled on 2026-11-16; the existing DB `set_openwa_test_pilot_mode` deliberately resets session limits to conservative 3/hour and 10/day and revokes former approvals when enabling. This was **not** a browser cache issue. The settings UI now warns about the reset and displays current saved caps. We have not bypassed the pause/no-grants admin editing restriction or silently restored 100/1000 while the current Pilot is active; operator can use STOP, review and reapprove exact consenting recipients, and save limits explicitly.
- **Evidence:** clean Migrations replay of 168 and dedicated `openwa-pilot-cohort-message-capacity-smoke.sql`, TEST remote schema application and readback, and latest-HEAD CI/unit tests tracked separately; **not** live acceptance or production readiness. NOTE-001 still applies.

### NOTE-015 — Agent Task operator controls (2026-11-16)

- Admin panel on TEST now has per-account worker enable/disable (durable `ai_runtime_policies.task_worker_enabled`), a read-only Task queue scan and per-Task pause/resume/cancel/manual finish. The switch does not disable other accounts nor alter WhatsApp sessions or Pilot grants. Locally, `npm run dev` must still have `WACRM_DEV_AGENT_TASK_WORKER=on` for timer polling; DB switch alone cannot start a stopped Node process.
- Migration `169_agent_task_operator_controls.sql` adds audited, account-scoped service-only RPCs and terminal evidence columns. Manual completion must have every Target completed and a linked Coverage Request fulfilled; early manual finishing is explicitly **not completed**. SQL atomically rejects unsafe in-flight/ambiguous sends, cancels queued Runs and unclaimed reservations and logs outcomes. Existing automated Task completion policies remain authoritative for non-manual closure.
- A task or worker STOP prevents future claims but cannot undo a WhatsApp message already handed to OpenWA; settle/reconcile it first. Production untouched; TEST + CI and live acceptance evidence remain separate. NOTE-001 still applies.
