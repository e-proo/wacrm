# SOF-23 — OpenWA-safe Agent Task TEST Cutover

**Status:** implementation preparation / controlled TEST acceptance pending.  
**Source of truth:** `e-proo/wacrm` branch `refactor/service-platform-v2`.  
**Scope:** Agent Task Phase 18, with Meta Cloud regression; no production deployment or live send authorization.

## Evidence captured on 2026-11-13

- Phase 18 preflight: user-provided Vitest `1 passed, 2 skipped`; activates nothing.
- Published `phase18-coverage-pilot` provider-backed dry run: user-provided Vitest `1 passed`, `simulation:true`; no transport call or business-count mutation.
- Hosted TEST `inspect_ai_agent_task_test_cutover_readiness`: `ready=true`, `mode=disabled`, no active Tasks or reconciliation reservations.
- TEST `whatsapp_connections`: the single **non-archived** OpenWA connection was `disconnected` when inspected, even though some **archived** connections were marked `ready`. Never silently choose archived sessions or infer readiness from OpenWA service alone.
- `coverage.sourcing_message@1` presently emits a Meta template unconditionally; the OpenWA adapter rejects `kind=template`.
- `reserve_agent_task_outbound_message` and `claim_agent_task_outbound_message` enforce a recent inbound 24-hour window for `kind=text` and approved template for `kind=template`.
- `resolveConversationTransport` derives transport from most recent customer message, then defaults to Meta when connection is absent. For Agent Task outbound, this fallback must not silently reroute an intended OpenWA send.
- OpenWA TEST uses its **separate** guarded pilot admission and pause/circuit/limit controls. Agent Task cutover flags do not replace the OpenWA connection guardrails.

## Work items in strict order

### A. Bind the target to an explicit transport connection (fail closed)

1. Inspect the current account-scoped connection, conversation, inbound-message and outbound-reservation relationships, including migrations 143–157 and existing RLS.
2. Add an **additive** migration only if needed (do not rewrite applied migrations) to persist the selected `connection_id` and provider on the durable Agent Task outbound reservation. Use a tenant-scoped FK or equivalent DB-validated lookup; preserve legacy Meta reservations.
3. Resolve provider at reservation time using the target's authorized conversation and a verified non-archived, ready/connected connection. Never accept an archived `ready` OpenWA session.
4. Before claiming/sending, re-check that the actual selected transport still equals the **frozen** reservation connection/provider; disallow silent Meta fallback. A missing/mismatched/offline session is a deterministic **pre-dispatch denial**. Mark a known pre-dispatch denial distinctly from an unknown post-dispatch outcome.
5. Do not give AI tools credentials or allow agents to choose provider/engine; routing is owned by WACRM transport.

**A acceptance:** OpenWA→OpenWA on exact connection; Meta→Meta unchanged; no-route, wrong tenant, archived, disconnected, switched session and missing credentials fail closed without a provider request.

### B. Provider-aware Coverage first message

1. Keep `coverage.sourcing_message@1` Meta path using `coverage_sourcing_supplier_v1` / `ar` approved template.
2. For OpenWA, use an **audited deterministic business-fact text** (never untrusted model-generated outreach copy), only on an authorized TEST contact/conversation and only if the DB last-inbound window is open. Include opt-out instruction; ensure no requester/private data is interpolated.
3. Keep SQL checks of suppressions, consent/opt-out, active inbound 24h window, reply stops, follow-up caps and message budgets. If any guard fails, **no send**. Do not emulate or fake Meta template approval for OpenWA.
4. Freeze changed message-contract behavior with a new policy/task-type version if it is incompatible with existing runs, following `outbound-policy.ts` registry semantics.
5. First contact on OpenWA with **no** recent authorized inbound stays blocked rather than downgrading template-first policy; TEST acceptance uses a conversation created from the test number's own inbound message.

**B acceptance:** Meta template + local APPROVED row remains mandatory; OpenWA text is only possible inside verified inbound window with approved test recipient. Out-of-window text cannot reach a provider.

### C. Guarded OpenWA workload and reconciliation

1. Mark calls initiated by the Agent Task worker as `workload='agent'` (not inferred as automation solely because `aiAgentRunId` was omitted). Do not alter ordinary automation/broadcast routing.
2. Enforce both gate families: `ai_runtime_policies.outbound_task_delivery_enabled` + `ai_agent_scope_controls`, AND OpenWA per-connection `pilot_enabled`/allowlist/manual pause/caps/circuit breaker.
3. Preserve a stable idempotency key on the same reservation through `messages.engine_idempotency_key` and provider adapter, including restart.
4. Provider errors/timeouts after transport ownership claim remain `requires_reconciliation`. No blind resend. Known pre-dispatch denies should not be mistaken for successful delivery.
5. Never relax Meta behavior to make OpenWA pass.

**C acceptance:** workload='agent' recorded at guarded adapter; no unapproved recipient; pause persists; duplicates and ambiguous outcomes do not create automatic second sends.

### D. Regression matrix / CI

| Case | Required assertion |
| --- | --- |
| Meta initial outreach | Approved template, unchanged |
| OpenWA in-window | Fixed, safe text, exact ready session |
| OpenWA first-touch without inbound | No send |
| Missing/archived/disconnected session | Pre-dispatch denied, no Meta fallback |
| Connection changes between reservation and send | No silent reroute |
| Other tenant's connection | Denied by tenant scope |
| Opt-out, pause, unapproved cohort, circuit, exceeded caps | No send |
| Repeated worker claim / restart | Idempotent, no blind resend |
| Unknown provider timeout | `requires_reconciliation`, manual reconciliation |
| Inbound reply | Correlated to exact target/task with opt-out/stop behavior |

Run relevant Vitest files, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and required Migrations CI if schema changes. Validate additive migration on TEST first and capture actual HEAD/CI run; don't mark `TEST verified` before these pass.

### E. One-target live TEST acceptance (external operator + evidence)

**Prerequisites:** items A–D green; TEST OpenWA connection `ready` and not archived; explicit allowlisted **test-only** contact with consent; verified recent inbound from that number; an eligible Coverage Request; approved frozen agent revision; no pending reconciliation. Do **not** turn on Pilot merely because preflight says `ready=true`.

1. Capture preflight, empty queue, exact account + selected connection, tenant restrictions and both pilot control sets.
2. Freeze `maxTargets=1`, `maxAttemptsPerTarget=1`, `maxFollowups=0`, and minimal daily caps. Keep other contacts/triggers ineligible; avoid historical broad caps.
3. Enable pilot through the guarded account cutover RPC only after explicit operator approval; separately authorize this single contact in OpenWA's connection-scoped cohort. Nothing is sent automatically just by enabling a flag.
4. Create precisely one authorized Task/Target, run worker once and record outbound reservation, message/provider ID, route, receiving test phone evidence and guardrail audit.
5. Reply from the test phone; verify webhook signature/dedup, reply correlation, target state/outcome and no extra follow-up or duplicated CRM session.
6. Exercise rollback via `set_ai_agent_task_test_cutover_mode(...,'disabled',...)`; verify account/channel gates disabled, inbound still works, nonterminal queue/reconciliation separately inspected. Pause OpenWA Pilot as necessary.
7. Record all evidence on SOF-23 and retain **In Progress** until live provider send/reply/rollback acceptance passes.

### Parallel closeout: SOF-19 → SOF-22

Review plan DoD and link green, relevant CI/migration evidence, authenticated two-account RLS smoke, runtime/cost/observability/security evidence. Distinguish implementation complete, TEST verified, live acceptance and production ready. Security NOTE-001 requires independent triage before any production-ready claim.

## Rollback / non-goals

- TEST changes only; no production mutations.
- Never force a disconnect/reconnection, auto-unarchive a session, or change provider on an existing business conversation just to make a test pass.
- Reversible code and **additive** migrations; no weakened RLS, no plaintext credentials, no separate CRM pipeline.
- No real outbound sending until E prerequisites and operator-controlled recipient are ready.
