# SOF-63 — One-target OpenWA TEST acceptance (operator-gated)

**Status:** NOT authorized for live send until all preflight gates pass. This document is an execution checklist, not proof of live acceptance.

## Safe preflight

1. On exact `refactor/service-platform-v2` HEAD verify CI + Migrations completed/success and TEST migration 159/160 available. Do not run on Production.
2. Inspect TEST `inspect_ai_agent_task_test_cutover_readiness(account_id)`. Require `ready=true`, `mode=disabled`, no ambiguous messages/active runs or open circuits before enrollment.
3. Choose precisely **one account-scoped, not archived, status=ready OpenWA connection**. Confirm its gateway session is genuinely connected; DB `ready` is not sufficient by itself. No Meta fallback.
4. Record **explicit consent** from the owner of a TEST-only number, and verify this same number sent a recent inbound **on the selected OpenWA connection**. No cold outreach.
5. Authorize the exact canonical OpenWA recipient in its connection-scoped Pilot allowlist. Keep `manual_paused=false` only on that TEST session, `pilot_enabled=true` and caps `hourly<=1`, `daily<=1`, `first_touch_daily<=1` while testing. Confirm cohort admission for `workload=agent`.
6. Prepare an eligible Coverage Request and a published `coverage.sourcing@2` Task binding on the agent, with `maxTargets=1`, `maxAttemptsPerTarget=1`, no follow-ups, scoped target contact, valid dry-run and budget caps.
7. Verify approved template remains required for any Meta execution. Do not use placeholder template rows to simulate Meta approval.

## Operator-controlled live sequence

- Explicitly activate only the TEST account cutover through the existing confirmation-gated RPC/test. Do not edit Production or global default flags.
- Create **one** manual Coverage Task in `Agents → مهام الوكلاء`, explicitly selecting that OpenWA session (or an authenticated latest inbound matching that session).
- Inspect the durable reservation before dispatch: `connection_id`, `provider=openwa`, `message_kind=text`, unique idempotency key, no more than one Target.
- Let only the Agent Task worker perform one bounded send. Capture local `message.id`, provider message ID, transport audit `workload=agent`, received TEST phone evidence; do not replay/duplicate even on timeout.
- Send a reply from the same TEST phone; verify signed webhook, replay/dedup, one inbound CRM message, reply-to-Task correlation, opt-out/stop where applicable. Record resulting Task Target state.
- Immediately rollback cutover to `disabled` with the existing confirmation-gated mechanism. Verify outbound_task_delivery_enabled=false, channel scope disabled, count zero active/sending, no accidental queued sends. Leave inbound running. Pause or restore OpenWA pilot controls to their prior safe state.
- Record precise GitHub HEAD, CI runs, TEST evidence, sanitized message IDs, user approval of the TEST number, and before/after guardrail settings on SOF-63.

## Current blocker (observed 2026-11-13)

The inspected TEST account had no non-archived OpenWA connection in status `ready`; its only current OpenWA connection was `disconnected`. The provided account also has no active Agent Task deliveries or authorized TEST recipient evidence in this conversation. **Do not activate or send until this changes.** Keep SOF-63 Backlog / blocked, irrespective of green CI.

## Acceptance result criteria

SOF-63 is **live acceptance complete** only with one real approved TEST send, real reply correlation, verified no duplicate and rollback. Green dry run, DB smoke or local template tests alone do not satisfy it. NOTE-001 security debt still precludes a general Production-ready declaration.
