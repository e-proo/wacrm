# Messaging Platform Rollout Plan

## Objective

Move WACRM operational messaging from scattered hard-coded strings to the generic Messaging & Business Events Platform without changing business decisions, approval semantics, execution ownership, or transport idempotency.

## Deployment principle

Do not perform a big-bang replacement. Migrate one message family at a time and compare output/state in TEST/STAGING before enabling the next family.

## Phase 0 — Foundation

Deliver:

- generic message contracts
- safe deterministic renderer
- account/system template resolver
- domain context builders
- versioned template schema
- documentation and tests

No existing production-path message must change in this phase.

Exit criteria:

- lint/typecheck/tests/build pass
- migration replay passes from a clean database
- migration is applied to TEST/STAGING only
- RLS and RPC privileges verified

## Phase 1 — Trusted-admin pending approval

Replace the hard-coded `change_request.pending` WhatsApp body with the renderer while preserving:

- one-time PIN transient boundary
- trusted identity capability check
- existing WhatsApp idempotency key
- in-app durable notification behavior
- no PIN persistence

Required tests:

- first creation sends PIN
- idempotent replay does not resend PIN
- account override can alter copy but cannot access undeclared secrets
- missing override falls back to system copy

Rollback:

- switch caller back to legacy formatter; no database rollback required

## Phase 2 — Admin outcome messages

Migrate:

- `change_request.approved`
- `change_request.rejected`
- safe failure messages where appropriate

Keep command parsing deterministic. Templates must never decide whether a change request is approved/rejected/executed.

## Phase 3 — Coverage customer outcomes

Migrate:

- `coverage.offer.approved`
- `coverage.request.approved`
- rejected/clarification messages through generic lifecycle fallback or specialized copy

Verify:

- SOUTH -> NORTH uses offer semantics and customer-receives commission label
- NORTH -> SOUTH uses request semantics and customer-pays commission label
- methods do not change direction classification
- authoritative amount/rate snapshot remains the source of numbers

## Phase 4 — Exchange rates

Migrate quote/trade messaging.

Rules:

- published rate service is authoritative
- template/KB never stores the current price
- buy/sell labels are presentation only; side/rate are supplied by domain logic
- rate timestamps/source metadata may be added to context when needed

## Phase 5 — Remittances

Introduce remittance lifecycle events such as:

- `remittance.pending`
- `remittance.approved`
- `remittance.completed`
- `remittance.rejected`

Do not emit `completed` while provider delivery/settlement is ambiguous.

## Phase 6 — Generic service adoption

New services should start on generic lifecycle templates:

```text
service_request.pending
service_request.approved
service_request.rejected
service_request.completed
```

Add specialized templates only when business presentation needs domain-specific fields.

## Phase 7 — Admin template editor

Build UI only after runtime correctness is proven.

Editor capabilities:

- list system defaults (read-only)
- list account revisions
- create new revision
- preview with safe sample context
- validate required/optional/secret variables
- publish revision
- rollback by publishing older revision
- unpublish account override to restore system default
- audit who published and when

Never expose secret values in preview fixtures.

## Runtime integration API

Target calling pattern:

```ts
const resolved = await resolveMessageTemplate({
  accountId,
  eventKey,
  audience: 'customer',
  channel: 'whatsapp',
  locale: customerLocale,
  store: createSupabaseTemplateOverrideStore(db),
})

const text = renderMessageTemplate({
  template: resolved.template,
  context,
  secrets,
})
```

Transport remains separate:

```ts
await engineSendText({
  ...transportContext,
  text,
  engineIdempotencyKey,
})
```

## Feature flag recommendation

Before broad runtime migration introduce an account/runtime policy flag such as:

```text
message_templates_enabled
```

During rollout:

- false -> legacy hard-coded formatter
- true -> new resolver/renderer

Once all migrated paths are stable and rollback confidence is high, remove the temporary dual-path flag.

## Observability

Add structured logs around rendering:

```text
[messaging] event=coverage.offer.approved source=system template=coverage.offer.approved locale=ar channel=whatsapp
```

For account overrides include revision/version, but never log secret values.

Monitor:

- template resolution failures
- missing required variables
- render length failures
- transport send failures
- retry/reconciliation counts
- override usage rate

## Failure policy

Transactional messaging should fail closed on malformed templates.

Recommended runtime behavior:

1. try account override
2. if override cannot be resolved, resolver naturally uses system default
3. if a published override resolves but fails render validation, log the revision and use the matching system default only if policy explicitly allows safe fallback
4. never silently omit a security-critical value such as an approval reference
5. never transform a business failure into a success message

For security-critical admin approval messages, a malformed customized template should fall back to the reviewed system template rather than losing the approval notification.

## Production promotion gate

Do not promote the platform migration to production until:

- all CI checks pass
- full migration replay passes
- TEST/STAGING RLS and grants verified
- approval PIN remains transient
- customer/admin messages verified end-to-end
- duplicate-send/idempotency behavior verified
- retry/reconciliation paths verified
- rollback to system defaults demonstrated
- no current prices or secrets are stored in template content

Production schema/data changes require an explicit production deployment decision after TEST/STAGING acceptance.
