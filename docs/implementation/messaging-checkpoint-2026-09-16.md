# Messaging Platform Continuation Checkpoint — 2026-09-16

This file is the exact handoff point for continuing the Messaging & Business Events work later.

## Hard boundaries

- Work only on Git branch: `test/ai-runtime-kb-tools-v2`.
- TEST/STAGING Supabase project: `wacrm test` (`pqirsnfupofhulmewakq`).
- Production project must remain untouched until an explicit production deployment decision.
- Exchange-rate/currency-trade and remittance services are **not ready**. Do not treat their template phases as blockers and do not invent runtime events for them yet.
- WhatsApp conversation-window/limits UX and retry button are deferred to a separate later phase.

## Repository checkpoint

Last functional code head before this documentation checkpoint:

```text
abd97ec37b7fce18f27dbb33df9e4842c7cfc18f
feat(messaging): render generic service outcomes at delivery
```

The CI and Migrations workflows for that functional head both completed successfully.

Documentation was then updated to record the current rollout state. Resume from the latest head of the same branch, not from `main`.

Useful restart commands:

```powershell
git switch test/ai-runtime-kb-tools-v2
git pull
git rev-parse --short HEAD
```

## Database migrations completed in this messaging phase

### 077 — Message template platform

File:

```text
supabase/migrations/077_message_template_platform.sql
```

Purpose:

- immutable account-owned template revisions
- explicit publication pointer
- audience/channel/locale/version identity
- required/optional/secret variable declarations
- RLS/grant foundation
- reviewed system defaults remain in code

This migration is the persistent foundation for account-specific template overrides.

### 078 — Atomic customer notification claim

File:

```text
supabase/migrations/078_customer_notification_atomic_claim.sql
```

Purpose:

- claim due customer outcome rows using PostgreSQL `now()`
- eliminate app/database clock-skew race
- atomically move `pending -> sending`
- use `FOR UPDATE SKIP LOCKED` for concurrent-worker safety
- increment attempts and assign claim token in the same database operation
- expose the claim RPC to `service_role` only

The RPC is:

```text
public.claim_customer_intent_notifications(uuid, uuid, integer)
```

## Messaging platform work completed

### 1. Generic platform foundation

Implemented reusable messaging infrastructure under `src/lib/messaging/`, including:

- catalog/contracts
- deterministic renderer
- template resolver
- Supabase override store
- default reviewed system templates
- domain context normalization
- validation and tests

Core principle:

```text
business truth -> normalized event/context -> template resolver -> deterministic renderer -> transport
```

Templates control wording only. They do not approve requests, classify direction, calculate business state, or decide execution success.

### 2. Trusted-admin pending approval

Event:

```text
change_request.pending
```

Implemented through the template platform.

Security invariant:

- approval confirmation code is transient
- it is not persisted in normal CRM messages or durable notification content
- the secret-bearing message uses the direct trusted-admin WhatsApp transport
- replay without a newly issued code does not blindly resend the old code

### 3. Trusted-admin outcomes

Events:

```text
change_request.approved
change_request.rejected
```

Implemented through the messaging platform after the deterministic decision/execution path.

Customer delivery status can be presented to the admin, but template text never changes the underlying decision.

Detailed doc:

```text
docs/implementation/messaging-phase-2-admin-outcomes.md
```

### 4. Coverage customer outcomes

Events:

```text
coverage.offer.approved
coverage.request.approved
```

Implemented with structured execution data rather than executor-owned final prose.

Coverage business semantics remain authoritative outside templates:

```text
SOUTH -> NORTH = offer = customer receives commission
NORTH -> SOUTH = request = customer pays commission
```

Methods such as cash/networks/remittance/bank deposit are presentation details and do not flip direction classification.

Commission amount is calculated from approved execution facts, not by the template.

Detailed doc:

```text
docs/implementation/messaging-phase-3-coverage-customer-outcomes.md
```

### 5. Generic service-request lifecycle

Generic customer events now include:

```text
service_request.approved
service_request.rejected
service_request.matched
service_request.needs_clarification
service_request.completed
```

A reusable renderer exists for these outcomes.

For current `service_intent` delivery, the customer-delivery layer reloads authoritative `change_request` state and maps supported decisions as follows:

```text
fulfilled   -> service_request.approved
rejected    -> service_request.rejected
matched     -> service_request.matched
clarifying  -> service_request.needs_clarification
```

The existing outbox `message_text` is retained only as a migration fallback if the decision/domain cannot be safely re-rendered.

`service_request.completed` is a generic contract only; it must not be emitted unless a real service has an authoritative completed state.

Key latest integration file:

```text
src/lib/ai/runtime/customer-notification-delivery.ts
```

## CHG-5 incident and exact diagnosis

Observed TEST flow:

```text
[messaging] event=coverage.request.approved ...
[admin change command] CHG-5 customer notifications claimed=0 sent=0 reconcile=0 failed=0
```

The coverage customer template rendered, but no row was claimed for transport at that instant.

Database inspection showed the notification existed in the customer outbox as `pending`, with zero attempts and no transport error. Therefore the failure occurred before WhatsApp transport and was not evidence of a WhatsApp conversation-window/limit failure.

Root cause:

- outbox `available_at` was generated from database time
- the old worker compared it to application/server time
- small clock skew could make a newly created row look a few seconds into the future
- immediate delivery therefore returned `claimed=0`

Fix:

- Migration `078_customer_notification_atomic_claim.sql`
- eligibility is now decided by PostgreSQL using its own clock
- claim is atomic and concurrency-safe

## What still needs to be verified before declaring the current template phase accepted

The implementation is in place, but the following TEST acceptance run is intentionally left as the exact next work item:

1. Sync the latest `test/ai-runtime-kb-tools-v2` branch locally.
2. Start the current application build against TEST/STAGING only.
3. Exercise a coverage approval end-to-end after migration `078`.
4. If the old `CHG-5` pending outcome is still valid for retry, use it; otherwise create one new TEST coverage request and approve it.
5. Confirm log/result shows a real claim, ideally:

```text
customer notifications claimed=1 sent=1 reconcile=0 failed=0
```

6. Verify the matching `customer_intent_notifications` row reaches `sent` exactly once.
7. Verify the customer actually receives the rendered WhatsApp outcome.
8. Verify the trusted admin receives the correct `change_request.approved` result.
9. Run/confirm CI and migration replay on the resulting branch head.
10. Record the successful TEST result in this checkpoint or a newer dated checkpoint.

If the row is claimed but WhatsApp then rejects the send, investigate that new transport error separately. Only at that point should WhatsApp message-window/eligibility be considered a possible cause.

## Explicitly deferred work

### Exchange rates / currency buy-sell

Status: **service not ready**.

Do not continue runtime template integration yet. The future template layer must consume authoritative buy/sell/rate facts from the real service; it must never store or invent current prices.

### Remittances

Status: **service not ready**.

Do not create a fake lifecycle just to complete template coverage. Introduce remittance events only after provider/settlement states and authoritative completion semantics exist.

### Admin template editor

Status: **not started by design**.

Future work after runtime acceptance:

- list system defaults
- create immutable account revision
- safe preview
- variable validation
- publish/unpublish
- rollback by publication pointer
- audit publisher/time

### WhatsApp conversation-window / limits UX

Status: **deferred to a separate operations phase**.

Future design ideas to evaluate later:

- show whether a customer conversation is currently eligible for free-form WhatsApp replies
- show last inbound customer timestamp / window state
- distinguish `pending`, `sending`, `sent`, `failed`, and `requires_reconciliation`
- provide an operator retry/resume action where safe
- define behavior when free-form messaging is unavailable and an approved Meta template would be required

Do not implement this until the current template/outbox runtime has passed TEST acceptance.

## What to do next when work resumes

Resume in this order:

1. **Do not add more template families yet.** First verify the `078` end-to-end delivery fix in TEST.
2. Verify one NORTH -> SOUTH coverage request approval reaches the customer and shows customer-pays commission wording.
3. Preferably verify one SOUTH -> NORTH coverage offer approval reaches the customer and shows customer-receives commission wording.
4. If a real `service_intent` test path is available, verify one generic service outcome renders through `service_request.*` rather than legacy prose.
5. Once those pass, mark the messaging-template phase accepted for the services that are actually ready.
6. Only then decide whether the next project phase is the admin template editor or WhatsApp delivery/window operations UX.
7. Leave exchange-rate and remittance message integration paused until those services themselves are ready.

## Definition of "template phase complete for now"

For the currently ready services, the phase can be considered complete when:

- template foundation migration `077` is present and replay-safe
- atomic outbox migration `078` is present and replay-safe
- admin pending approval uses templates without persisting the confirmation secret
- admin approved/rejected outcomes use templates
- coverage offer/request approved outcomes use templates
- generic `service_request` renderer exists and current `service_intent` supported decisions use it at delivery
- customer outbox delivery after `078` is proven end-to-end in TEST
- CI and migrations are green
- no production changes have been made

Exchange-rate, remittance, admin-editor, and WhatsApp-window UX are **not required** for this checkpoint because they are explicitly future work.
