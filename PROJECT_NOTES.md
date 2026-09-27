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

### NOTE-002 — Meta/Instagram restriction blocks Intents WhatsApp Gate C

- **Status:** open / external blocker
- **Recorded:** 2026-09-27
- **Discovered during:** Service Platform V2 Phase 1 — Intents active WhatsApp E2E
- **Scope:** Meta account/app availability; not a proven defect in Intents, Business Events, or Supabase cutover contracts.
- **Current Service Platform state:** Gate A parity PASS (4/4), Gate B activation PASS, Intents route `service_request_customer_whatsapp` is `active` and readiness is `true`. Gate C and Gate D remain open.
- **Evidence:** The stored WhatsApp access token in `wacrm test` decrypts successfully with the current `WACRM_TEST_ENCRYPTION_KEY`. Direct Meta checks for both phone metadata and WABA `subscribed_apps` currently return HTTP 400 with `API access blocked`. New manual WhatsApp messages do not reach the application's webhook or TEST database.
- **User context:** The linked Instagram account currently has a restriction associated with the Meta/Facebook developer setup. The user is addressing that restriction separately.
- **Why deferred:** This cannot be safely resolved by changing Service Platform code while Meta API access itself is blocked.
- **Do not do while deferred:** do not remove legacy notification fallback, do not run Phase 5 contraction, do not rotate `ENCRYPTION_KEY`, and do not treat old `registered_at/subscribed_apps_at` timestamps as live proof.
- **Parallel work allowed:** AI subsystem improvements may proceed. If they touch customer notification delivery, Intents, WhatsApp webhook/config, Meta send transport, legacy registry, or cutover migrations/contracts, Phase 1 must be revalidated before closure.
- **Return-to-work criteria:** Meta restriction removed; phone metadata and WABA subscribed-app checks succeed; callback URL and `messages` webhook subscription verified; fresh inbound from the selected TEST contact reaches `/api/whatsapp/webhook` and TEST. Then execute Gate C active delivery + duplicate check, Gate D rollback, optionally re-activate TEST, mark Phase 1 COMPLETE, and only then start Phase 5.

