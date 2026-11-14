# SOF-63 — Deterministic Coverage V2 outbound handoff regression

## Observed TEST failure (2026-11-14)

With one validated TEST-only Task `86e1cbc3-4d2b-4f1f-8f81-45fd64889c1d` and exactly one selected target, the operator's `send` stage invoked the model loop, which returned `handoff` without tools or text. `processAgentTaskOutboundRunQueue` interpreted that as `needs_human` and called `fail_agent_task_outbound_run`, exhausting the target's one attempt. Test result: `scanned=1,attempted=1,reserved=0,sent=0,reconciliation=0,failed=1`.

Hosted TEST evidence: `ai_agent_runs.status=failed`, `error_code=AGENT_OUTBOUND_NEEDS_HUMAN`, target `status=exhausted`, `attempt_count=1`, zero outbound reservations. This is **not an OpenWA transport failure** and no WhatsApp send from the Task occurred. **Do not repeat `send` or reset the exhausted attempt.**

## Root cause and bounded fix

`coverage.sourcing_message@2` is intentionally server-owned deterministic text/template selected by a frozen session provider, and ignores `modelCandidateText`. Yet the outbound worker ran the generative model loop and required that loop not handoff *before* asking the domain policy for a deterministic candidate. The model could handoff on unrelated chat history even though it had no authority to formulate the first outreach message.

- Add an explicit `generation: 'deterministic'` opt-in to the message policy contract, used **only** for Coverage V2; absent/default preserves legacy model-first and handoff.
- The worker retains the AI revision/provider boundary, Task/Target frozen association, and circuit/runtime gates. For an opted-in deterministic policy it additionally calls `authorizeStoredAgentTask` to revalidate frozen Task, revision capabilities and tool policies, status and account scope, then calls `prepareAndReserveCurrentTaskOutboundMessage` with `modelCandidateText=null`. The SQL transaction still verifies eligible target, subscription, time window, exact provider connection, and quotas; delivery remains through the same WhatsApp transport and ambiguity reconciliation.
- Never treat `needs_human` as a success for model-required Task types, and do not use deterministic policy as a general override for arbitrary LLM handoffs.
- Unit regression: deterministic route skips model and still enforces capability checks; legacy V1 handoff fails; runtime gate denies. No schema changes.

## Failed Task recovery and acceptance

Because the original Task target was exhausted without any reservation, it **cannot** be safely retried or requeued: `max_attempts_per_target=1` was an intentionally frozen safety cap. The existing Task completion policy can finalize the exhausted Task after checking zero reservations; a new isolated TEST Task with a unique idempotency identity/revision or a new TEST-only Request can then be created *after* fresh recipient consent/inbound and a renewed `agent` allowlist grant. Do not create a duplicate Task until the previous one is terminal, and don't silently expand caps.

Re-run existing automated CI and TEST-only dry run. One-target **live acceptance still pending**: new Task, scoped prepare, scoped send, receipt, reply and rollback. Production readiness remains out of scope.

## Scoped failure finalization — no send, no retry

The existing `evaluateCurrentTaskCompletion` policy finalizes a `running` Coverage Task with only `exhausted` targets as `partially_completed / supplier_targets_exhausted`. This is a terminal state, not delivery success. An opt-in `finalize_failed` stage was added to the SOF-63 live test command to call **only** this domain completion policy after verifying that the exact TEST Task has one exhausted target, one failed outbound Run, both with `AGENT_OUTBOUND_NEEDS_HUMAN`, and zero reservations.

```powershell
$env:WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID="8ed95309-96cd-4347-b725-bd8c5039ed4f"
$env:WACRM_AGENT_TASK_ONE_TARGET_TASK_ID="86e1cbc3-4d2b-4f1f-8f81-45fd64889c1d"
$env:WACRM_AGENT_TASK_ONE_TARGET_LIVE="1"
$env:WACRM_AGENT_TASK_ONE_TARGET_STAGE="finalize_failed"
$env:WACRM_AGENT_TASK_ONE_TARGET_CONFIRM="FINALIZE_FAILED_NO_SEND"
npm run test:agent-task-one-target-live
```

This stage never calls the worker, creates a Target/Run/reservation, sends WhatsApp, or resets attempts. It must be invoked **only after green CI** and with operator confirmation. Do not run `prepare` or `send` against the failed Task. After finalization, create a *new TEST-only request/Task identity* (because the existing manual Coverage idempotency key includes request + agent + frozen revision), and verify renewed consent/inbound and OpenWA recipient grant before a second live acceptance attempt. No automatic resend.

## Second isolated TEST attempt fixture

The first Task was closed on hosted TEST at 2026-11-14 14:33 UTC (`partially_completed`, zero reservations). Additive second Coverage Request `82e81d51-7a14-4d83-91cc-b8b40534f7d0` uses the same `SOF63-TEST-20261114` isolated service and one previously confirmed supplier; previous Request remains unchanged. New service-owned request is `active`, 100 SAR, no active business-event rows. No Agent Task or WhatsApp message was created by the fixture operation.

The TEST acceptance worker is now restricted to the new Request, the exact TEST account, the explicit approved CRM contact and OpenWA session. The `finalize_failed` stage remains pinned to the previous Request for historical cleanup only. Green CI, a new UI-created Task, and fresh preflight must precede any new live send; the operator's explicit action is still required.
