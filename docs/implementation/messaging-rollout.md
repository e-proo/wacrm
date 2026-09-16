# Messaging Platform Rollout Plan

## Objective

Move WACRM operational messaging from scattered hard-coded strings to the generic Messaging & Business Events Platform without changing business decisions, approval semantics, execution ownership, or transport safety.

## Deployment principle

Do not perform a big-bang replacement. Migrate one message family at a time and compare output/state in TEST/STAGING before enabling the next family.

## Phase 0 — Foundation ✅ implemented

Delivered:

- generic message contracts
- safe deterministic renderer
- account/system template resolver
- domain context builders
- versioned template schema
- documentation and tests

Migration: `077_message_template_platform.sql`.

The foundation itself did not alter existing operational messaging paths.

## Phase 1 — Trusted-admin pending approval ✅ implemented on TEST branch

`change_request.pending` now renders through the Messaging Platform.

Preserved invariants:

- trusted identity capability check remains authoritative
- idempotent create-change replay receives no historical plaintext PIN and does not resend the approval body
- durable in-app notification remains PIN-free
- malformed/unavailable account override falls back to the reviewed system template
- the template must contain both `{{entity.reference}}` and the declared `{{secret.confirmation_code}}` placeholder
- template resolution logs source/revision/version only; secret values are never logged

Security hardening added during this phase:

- the secret-bearing approval WhatsApp body no longer uses `engineSendText`
- it is sent only through the direct trusted-admin Meta transport
- therefore the plaintext approval PIN is not persisted into the CRM `messages` table
- the durable dashboard notification remains available without the PIN if direct WhatsApp delivery fails

This intentionally replaces the previous persisted-message idempotency mechanism for this one secret-bearing message. Replay safety is instead anchored at `create_change_request_v2`: an idempotent replay does not return the historical PIN, so the notifier cannot blindly resend it.

Required tests implemented:

- system template renders the one-time PIN and reference
- valid account override renders successfully
- override that omits the PIN placeholder falls back to system copy
- unavailable override store falls back to system copy
- trusted-admin secret-bearing path does not call `engineSendText`
- durable in-app block does not reference the confirmation code

Rollback:

- restore the previous hard-coded formatter/direct caller; no database rollback is required
- unpublishing an account override immediately restores the system template

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

Transport remains separate. Normal non-secret operational messages can continue to use `engineSendText` and its idempotency reservation. Secret-bearing trusted-admin approval messages use the direct verified-admin transport so the secret is not persisted.

## Feature flag recommendation

A broad flag is not required for Phase 1 because the security-critical renderer has a reviewed system fallback and the migration is isolated to one message family. If later migrations introduce multiple editable customer-facing families at once, an account/runtime flag such as `message_templates_enabled` can be introduced for staged rollout.

## Observability

Structured render logs use metadata only:

```text
[messaging] event=change_request.pending source=system template=change_request.pending locale=ar channel=whatsapp
```

For account overrides include revision/version. Never log rendered secret values.

Monitor:

- template resolution failures
- missing required variables
- unsafe approval-template fallback reasons
- render length failures
- transport send failures
- retry/reconciliation counts
- override usage rate

## Failure policy

Transactional messaging fails closed on malformed templates except where an explicitly reviewed system fallback is safer than dropping a security-critical notification.

Runtime behavior:

1. try account override
2. if none exists, use system default
3. if a published security-critical approval override is malformed or the override store is unavailable, use the reviewed system `change_request.pending` template
4. never omit the approval reference or one-time PIN from the trusted-admin approval body
5. never transform a business failure into a success message
6. never persist transient secret values into template storage, durable notifications, or normal CRM message history

## Production promotion gate

Do not promote the platform migration to production until:

- all CI checks pass
- full migration replay passes
- TEST/STAGING RLS and grants verified
- approval PIN remains transient end-to-end
- customer/admin messages verified end-to-end
- duplicate-send/idempotency behavior verified
- retry/reconciliation paths verified
- rollback to system defaults demonstrated
- no current prices or secret values are stored in template content

Production schema/data changes require an explicit production deployment decision after TEST/STAGING acceptance.
