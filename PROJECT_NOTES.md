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
