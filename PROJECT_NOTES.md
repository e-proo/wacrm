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
