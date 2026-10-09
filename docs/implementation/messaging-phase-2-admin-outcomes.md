# Messaging Phase 2 — Trusted-admin outcomes

## Scope

Phase 2 migrates the trusted-admin response after a deterministic change-request decision to the Messaging & Business Events Platform.

Events:

- `change_request.approved`
- `change_request.rejected`

The command parser, authorization checks, approval/rejection RPCs, deterministic executor, and customer notification delivery remain the source of truth. Templates only control presentation after the business decision has already occurred.

## Runtime flow

### Approval

```text
trusted admin command
  -> approve_change_request_by_code_v2
  -> deterministic executeApprovedChangeRequest
  -> best-effort customer outcome delivery
  -> load authoritative change-request context
  -> resolve change_request.approved template
  -> render admin copy
  -> return reply to trusted admin
```

### Rejection

```text
trusted admin command
  -> rejectChangeRequest
  -> best-effort customer outcome delivery
  -> resolve change_request.rejected template
  -> render admin copy
  -> return reply to trusted admin
```

## Safety invariants

1. A template never decides whether a change request is approved, rejected, executed, or failed.
2. Outcome rendering happens after the deterministic state transition.
3. Outcome templates may not declare or reference secret variables.
4. Every outcome template must include `{{entity.reference}}`.
5. A malformed account override falls back to the reviewed system template.
6. If even the system template unexpectedly fails, an emergency deterministic copy is returned so a successful business mutation is never reported as a generic execution failure.
7. Customer notification failure does not roll back or rewrite the human decision.

## Context contract

The renderer receives normalized context only. Typical fields include:

```text
entity.reference
entity.status
entity.status_label
service.id
service.name
money.amount
money.currency
data.type_label
data.summary
data.reason
data.customer_delivery_label
```

Domain values come from the persisted `change_requests` row and its authoritative `proposed_payload`; the template does not query business tables or calculate amounts.

## Customer delivery labels

The admin outcome copy can report follow-up delivery without changing the business result:

- sent -> customer was notified
- requires reconciliation -> send state must be reconciled
- failed -> outcome remains recorded for review
- no pending notification -> no new notification was waiting
- delivery worker exception -> delivery status could not be verified

## Override behavior

Resolution order remains:

```text
account override for requested locale
  -> account override for locale fallback
  -> reviewed system template
  -> emergency deterministic copy (unexpected system-render failure only)
```

Published overrides use the immutable revision/publication schema from migration `077_message_template_platform.sql`.

## Observability

Successful rendering emits metadata-only logs:

```text
[messaging] event=change_request.approved source=system template=change_request.approved locale=ar channel=whatsapp
[messaging] event=change_request.rejected source=account template=change_request.rejected locale=ar channel=whatsapp revision=<id> version=<n>
```

No confirmation PIN or other secret is part of these outcome events.

## Test coverage

Automated tests cover:

- system approval outcome rendering
- valid account override
- secret-bearing override rejection and system fallback
- rejection reason rendering
- customer delivery status rendering

End-to-end TEST/STAGING acceptance should exercise both an approval and a rejection before Phase 3 is enabled.

## Rollback

No schema rollback is required. Runtime rollback consists of restoring the previous hard-coded admin reply. Account-level copy rollback can be performed by publishing an older revision or unpublishing the override to restore the system default.
