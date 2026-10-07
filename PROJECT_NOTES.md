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
