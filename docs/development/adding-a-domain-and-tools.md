# Developer Guide: Add a New Domain/Service and Its Agent Tools

This is the required extension path for new WACRM business capabilities. The objective is to make a new domain behave consistently with services, pricing, exchange rates, coverage, and intents without introducing arbitrary model writes.

## 0. Decide whether this is a domain or a catalog service

A **catalog service** is customer-facing business configuration inside the existing `services` domain.

A **new domain** is a distinct operational subsystem with its own records/lifecycle, for example payments, delivery, bookings, or compliance cases.

Do not create a new domain merely to add another configured service row.

## 1. Define authoritative data first

Before AI tools, define:

- tenant-owned tables with `account_id`;
- lifecycle/status values;
- immutable/versioned data where history matters;
- RLS;
- DB tenant-integrity constraints/triggers;
- optimistic concurrency/version token for mutable state;
- audit events;
- idempotency keys for externally-triggered writes.

AI must sit on top of a correct domain model, not become the domain model.

## 2. Define domain capabilities

Choose stable, narrow capabilities, for example:

```text
payments.read
payments.propose
payments.refund_propose
```

Do not create vague super-capabilities like `payments.all` unless the product intentionally needs them.

If a tool is admin-plane and model-exposed, the manifest must declare at least one capability.

## 3. Define READ DTOs

Create server-side read services that return the minimum data required for the model/plane.

Customer DTO and admin DTO should be separate when admin data contains internal identity, cost, risk, or notes.

Never return a database row with `select('*')` and assume the prompt will hide sensitive fields.

## 4. Define the proposal payload

For a mutation, define a typed payload that is complete **before approval**.

Bad:

```json
{ "instruction": "refund this customer as appropriate" }
```

Good:

```json
{
  "payment_id": "...",
  "amount": "120.00",
  "currency": "SAR",
  "reason_code": "duplicate",
  "expected_version": 7
}
```

The proposal must capture source context and expected version where concurrent edits are possible.

## 5. Define deterministic execution

Implement a server-only handler for the approved target/intent.

Requirements:

- validate the stored typed payload again;
- verify account ownership;
- verify expected version/CAS;
- use transaction/RPC when business mutation + workflow state must be atomic;
- make retries replay safe;
- emit audit/outbox events;
- never ask the LLM to reinterpret the approved request.

## 6. Create tool manifests

Create tools in the domain module. Typical domain has:

```text
domain.search/read     -> READ
domain.propose_*       -> PROPOSE
domain.execute_*       -> EXECUTE (serverOnly, modelExposed=false)
```

Use `PlatformToolManifest`. Every manifest needs explicit `whenToUse` and `whenNotToUse` rules.

The contract validator must pass at build/test time.

## 7. Register the domain

Use `defineDomain()` and register it in the platform registry. Duplicate domain/tool-version pairs must fail startup/CI.

Do not add a second policy map. Runtime plane/capability behavior belongs in the tool manifest.

During legacy migration, `platformManifestFromLegacy()` is allowed only for pre-platform tools. New tools should not need the bridge.

## 8. Register executors — do not add dispatch switch cases

Register each exact `tool_key@version` in the domain/platform `ToolExecutorRegistry`. The dispatcher resolves the validated manifest and then executes the exact registered handler.

Do **not** add a new `switch (toolKey)` branch in the central runtime. A domain is incomplete if its manifest exists but its exact-version executor is missing; runtime must fail closed with `TOOL_EXECUTOR_MISSING`.

Server-only EXECUTE handlers used by approved Change Requests remain deterministic domain handlers; they are never provider-visible.

## 9. Wire model-visible tools

Provider schemas are emitted only after the registry intersects:

- exact frozen revision grants;
- runtime plane;
- trusted-admin capabilities.

The provider description is generated from the manifest. Do not hand-write a separate tool prompt.

## 10. Bind server context

Never accept these from a customer-plane model when runtime already knows them:

- `account_id`
- contact/customer identity
- conversation ID
- inbound message ID
- trusted admin identity
- agent revision ID

Pass them through `ToolContext` from server-side dispatch.

## 11. Add grants/templates intentionally

A tool existing in the registry does not make it available to an agent.

Update the appropriate agent template/preset only if the product wants new revisions to suggest that tool. The human still publishes a revision with explicit grants.

Customer templates must never suggest admin-only proposal tools.

## 12. Add tests before registration

Minimum contract tests for every tool/domain:

1. manifest validation passes;
2. unknown/stale tool version fails;
3. wrong plane fails;
4. missing admin identity/capability fails;
5. grant permission mismatch fails;
6. unsupported constraint fails;
7. cross-account resource fails;
8. malformed/unknown arguments fail;
9. customer DTO contains no internal fields;
10. simulation causes no proposal/write;
11. proposal is idempotent;
12. executor replay is idempotent;
13. expected-version conflict is detected;
14. approval is required for high-risk proposal;
15. authoritative executor is not model-exposed;
16. audit/outbox event is emitted as required.

Add domain-specific E2E coverage for the real workflow.

## 13. End-to-end acceptance scenario

For every new mutating domain, write at least one scenario with this shape:

```text
Inbound message/admin instruction
 -> correct agent route
 -> READ tools if needed
 -> complete typed PROPOSE tool
 -> stored Change Request
 -> explicit human approval
 -> deterministic executor
 -> authoritative domain state
 -> audit event
 -> idempotent notification/result to originating workflow
```

Retries at every boundary must not duplicate business mutations or outbound notifications.

## Reference skeleton

See:

`src/lib/ai/tools/platform/example-domain.ts`

It demonstrates a read tool, admin proposal tool, and server-only execute tool. It is intentionally a reference and must not be registered as a production domain.

## Pull-request checklist

A PR adding a domain is not complete until it includes:

- migrations/domain model;
- RLS + tenant integrity;
- service/repository layer;
- manifest(s);
- proposal schema;
- deterministic executor;
- audit/idempotency;
- tool grants/template changes when needed;
- contract/unit tests;
- E2E scenario;
- documentation update.
