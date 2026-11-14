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
