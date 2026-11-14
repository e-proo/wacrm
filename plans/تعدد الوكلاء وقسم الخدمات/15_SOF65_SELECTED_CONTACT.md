# SOF-65 — Explicit existing CRM contact targeting for Coverage tasks

## Architecture (Source of Truth: refactor/service-platform-v2)

1. An admin with `agents.manage_tasks` can search current-account `contacts` (name/phone), choose one explicit contact from WACRM when configuring a `coverage.sourcing` Task, and view a read-only eligibility preview.
2. `startCoverageSourcingTask` persists `target_policy.selectedContactId` only after checking contact ownership, eligible Coverage supplier-history matching the source request, agent Builder/region scope, and one-target cap. It requires explicit contact on manual OpenWA Tasks; there is **no automatic substitute recipient**.
3. `coverage.supplier_candidates` filters query results by selected ID **before LIMIT**, then still runs anti-parallel Coverage attribute matching, source Request status/remaining amount and domain region scope. The existing `materialize_agent_task_contact_target` RPC remains the authority for tag/opt-out/consent, tenant, budgets and contact cooldown. `reserve_bound_agent_task_outbound_message` also checks the precise connection and 24-hour inbound window.
4. `update_pending_agent_task_target` is an additive, service-role-only RPC that reuses the existing SOF-64 serialized pending connection editor and checks account, actor owner/admin, selected contact and one-target cap. A Task with Targets, Runs or Reservations, or already running, cannot switch recipient.
5. The recipient choice is separate from the session choice and from the Agent global settings. No new transport, business pipeline or credentials in the browser.
6. Old V1 and trigger paths remain compatible; manual OpenWA TEST sends require explicit recipient choice. No `Pilot` or `Cutover` auto-enablement.

## TEST-only fixture and acceptance

- Identify **only** the own-number consented contact by matching the active `agent` allowlist's hashed native chat identity to a recent inbound in the correct TEST account/session. Do not print phone numbers, recipient JIDs or tokens.
- Create exactly one marked `[SOF-63 TEST ONLY]` Coverage Request and one matching, marked historical `coverage_offers` supplier row for this existing contact, if and only if the account's existing TEST business schema permits safe inserts. These are sandbox business records, not real offers or outreach; record their UUIDs for eventual deletion/rollback after acceptance.
- Before any Task is created, verify the domain resolver yields exactly the chosen test contact when `selectedContactId` is present, even though other suppliers may be eligible under automatic selection. Negative test must demonstrate foreign contact / no history denied.
- Keep account `Cutover=disabled` throughout preparation. OpenWA Pilot may be active under operator control; code/tests/fixture creation do not send WhatsApp. Do not run the live outbound worker. TEST Pilot grant expires and must be renewed by an operator if needed at time of acceptance.
- Only SOF-63 can activate and execute the real one-target send/reply/rollback with exact approval, no blind resend and the existing guardrails; this phase is not live acceptance or Production Ready.

## Definition of Done

- Latest HEAD CI lint/typecheck/tests/build passed.
- Migration 161 and selected-contact smoke replay green; applied to TEST only; service-role RPC grants and runtime gates checked.
- Manual UI search/picker and per-Task update verified in TEST (may be recorded separately from automated tests).
- Opt-in, opt-out, provider-specific guardrails and tenant isolation unchanged.
