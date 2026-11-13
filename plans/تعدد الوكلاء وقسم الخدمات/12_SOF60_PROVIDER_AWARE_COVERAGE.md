# SOF-60 — Provider-aware Coverage first message

- **Legacy Coverage Task V1 remains template-first on Meta** and is not rewritten.
- **Coverage Task V2** uses the existing domain-owned Coverage snapshot and chooses between the same approved Meta template `coverage_sourcing_supplier_v1` and deterministic Arabic OpenWA text.
- OpenWA text requires a real recent inbound on the **same selected session**, a ready non-archived tenant-scoped connection, outbound Task cutover gates, stop-on-reply/opt-out, and the independent OpenWA pilot allowlist/limits/circuit. Missing route, stale inbound, unsupported template or provider change is denied before dispatch.
- No LLM-generated outreach copy, no requester identity, no private supplier data; frozen numeric amount and ISO currency values are shape validated. Avoid cold first-touch over OpenWA and do not emulate Meta template approval.
- The V2 provider is resolved from the Task's frozen `target_policy.whatsappConnectionId` (or exact latest linked inbound) before the deterministic domain message policy. An additive SQL wrapper compares this expected provider to the actual provider from the SOF-59 bound reservation in one transaction; a mismatch raises and rolls back.
- V1/V2 share business outcomes, resolver, tool policy and completion semantics. Existing trigger V1 remains V1; a V2 trigger variant is registered separately.
- **TEST acceptance:** run `coverage/agent-task.test.ts`, the SQL `agent-task-transport-binding-smoke.sql`, CI/Migrations CI, apply additive migration on TEST, verify permissions and disabled cutover. No live send until SOF-63.
