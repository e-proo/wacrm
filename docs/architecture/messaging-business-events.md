# Messaging & Business Events Architecture

## Status

Foundation introduced on `test/ai-runtime-kb-tools-v2`. The foundation is intentionally not wired into every existing operational message yet. Migration should be incremental so the already-verified approval/execution loop keeps its deterministic behavior during rollout.

## Goals

The messaging platform separates four responsibilities that must not be mixed:

1. **Business truth** — what actually happened, derived from database state and deterministic domain services.
2. **Message context** — a normalized, presentation-safe projection of that truth.
3. **Template selection and rendering** — how the event is expressed for a specific audience, channel, and locale.
4. **Transport** — WhatsApp, in-app, email, SMS, or a future channel.

Knowledge Base content remains separate. KB explains services and guides conversational agents; it must not be the source of truth for transactional outcomes, prices, approval state, reference numbers, or current rates.

## Architectural flow

```text
Domain operation / change request / scheduled process
                 |
                 v
        Stable business event key
                 |
                 v
        Normalized MessageContext
                 |
                 v
       Template resolver hierarchy
      /                         \
account published override   system default in code
      \                         /
                 v
         deterministic renderer
                 |
                 v
       channel-specific transport
```

## Event naming

Event keys are lowercase stable business identifiers, independent from RPC names, AI tools, database table names, and transport details.

Recommended convention:

```text
<domain>.<entity-or-action>.<state>
```

Examples:

- `change_request.pending`
- `change_request.approved`
- `coverage.offer.approved`
- `coverage.request.approved`
- `exchange_rate.quote.completed`
- `exchange_rate.trade.approved`
- `remittance.completed`
- `service_request.approved`

The suffixes `pending`, `approved`, `rejected`, `completed`, and `failed` participate in the generic service fallback contract.

## Future-service fallback

A new domain does not need bespoke copy before it can function safely. For example:

```text
bill_payment.approved
```

resolves in this order:

```text
bill_payment.approved
service_request.approved
```

A specialized template may be added later without changing the calling domain logic.

## MessageContext contract

Templates consume a normalized object and never query tables directly.

Reserved roots:

- `account` — tenant display information.
- `customer` — customer-safe identity fields.
- `actor` — admin/system/agent identity when appropriate.
- `entity` — type, id, reference, status.
- `service` — id, code, display name.
- `money` — already-formatted amount, currency, fee, commission.
- `data` — domain-specific scalar fields.

Example coverage context:

```json
{
  "entity": {
    "type": "coverage_offer",
    "reference": "CHG-24"
  },
  "service": {
    "name": "التغطية"
  },
  "money": {
    "amount": "150,000",
    "currency": "SAR",
    "commission": "1,050"
  },
  "data": {
    "pay_region": "حضرموت",
    "pay_method": "نقدًا",
    "receive_region": "صنعاء",
    "receive_method": "شبكات",
    "commission_label": "الراجع لك"
  }
}
```

The domain adapter is responsible for business semantics such as whether commission is returned to or paid by the customer. The template only displays the supplied fact.

## Templates

Templates are deterministic plain text with a deliberately small language:

```text
{{entity.reference}}
{{money.amount}}
{{#if data.summary}}...{{/if}}
```

Not supported intentionally:

- arbitrary JavaScript
- database expressions
- loops
- remote calls
- AI generation inside the renderer
- implicit business calculations

This keeps transactional messages auditable and reproducible.

## Secrets

Secrets are a separate transient namespace:

```text
{{secret.confirmation_code}}
```

A template must explicitly declare the secret key before the renderer will use it. Secret **values** are never stored in template revisions or publication rows and must not be added to the general `MessageContext`.

For the change-request approval PIN, the secret continues to exist only during first delivery to the verified trusted-admin identity.

## Resolver precedence

For a request such as:

```text
event      = coverage.offer.approved
audience   = customer
channel    = whatsapp
locale     = ar-YE
```

the resolver checks account overrides before repository defaults and applies both locale and event fallbacks:

1. account `coverage.offer.approved / ar-YE`
2. account `coverage.offer.approved / ar`
3. account `service_request.approved / ar-YE`
4. account `service_request.approved / ar`
5. system `coverage.offer.approved / ar-YE`
6. system `coverage.offer.approved / ar`
7. system `service_request.approved / ar-YE`
8. system `service_request.approved / ar`

If nothing matches, resolution fails closed with `MESSAGE_TEMPLATE_NOT_FOUND`.

## System defaults vs account overrides

System defaults live in source control under `src/lib/messaging/defaults.ts`. They are reviewed, tested, and released with application code.

Account customizations live in Supabase:

- `message_template_revisions` — immutable history.
- `message_template_publications` — current published revision pointer.

A publication can be rolled back simply by republishing an older revision. Published text is never edited in place.

## Database security model

`077_message_template_platform.sql` establishes:

- tenant-scoped rows
- admin read access through RLS
- revision creation through `create_message_template_revision`
- explicit publication through `publish_message_template_revision`
- rollback/unpublish through the publication pointer
- no anonymous access
- service-role support for internal runtime operations

Direct authenticated mutation of revision rows is intentionally not granted.

## Domain adapters

The platform ships with context builders for:

- generic/future services
- coverage offers and requests
- exchange-rate quotes
- remittances

These are examples of the adapter pattern, not a closed list. A new service should add only the fields needed to describe its business result and should reuse generic reserved roots whenever possible.

## Example: exchange rates

`exchange_rate.quote.completed` may carry:

```json
{
  "entity": { "type": "exchange_rate" },
  "data": {
    "base_currency": "SAR",
    "quote_currency": "YER",
    "buy_rate": "425",
    "sell_rate": "428",
    "market_label": "الشمال"
  }
}
```

The current rate must come from the authoritative rate service/tool. It must never be sourced from a template or KB article.

## Example: remittance

`remittance.completed` can contain:

- transaction reference
- amount and currency
- beneficiary display name when disclosure is allowed
- destination
- delivery method

The renderer does not infer completion. The remittance domain emits the event only after the deterministic operation reaches the completed state.

## Observability requirements

When the runtime integration is activated, every rendered transactional message should log structured metadata without message secrets:

- account id
- business event key
- resolved template key
- template source (`account` or `system`)
- template revision/version when customized
- audience
- channel
- locale
- business entity id/reference
- transport result/idempotency key

Never log `secrets` or plaintext approval codes.

## Reliability and idempotency

Template rendering is not itself a delivery guarantee. Transport workers continue to own:

- idempotency reservation
- provider delivery
- retry policy
- reconciliation for ambiguous sends
- final sent/failed status

A message event should have a stable business idempotency key, for example:

```text
business-message:<event>:<entity-id>:<audience>:<channel>
```

## Knowledge Base boundary

Use Knowledge Base for:

- explaining what a service is
- customer FAQs
- terminology and business guidance
- conversational tone guidance
- service eligibility explanations that are not volatile transaction state

Do not use Knowledge Base for:

- current buy/sell prices
- current published commission rate
- approval state
- whether a transfer actually completed
- transaction/reference ids
- one-time secrets
- account-specific operational results

Those facts must come from deterministic tools/database state and are inserted into `MessageContext`.

## Rollout strategy

1. Land foundation, schema, tests, and documentation.
2. Apply migration to TEST/STAGING.
3. Wire `change_request.pending` first while preserving the existing secure PIN boundary.
4. Wire admin approval/rejection outcome messages.
5. Wire coverage customer outcomes and compare old/new messages in TEST.
6. Wire exchange-rate and remittance events.
7. Add an admin template editor with preview + validation + publish/rollback.
8. Add cache only after correctness and invalidation rules are proven.
9. Promote to production only after regression tests and delivery reconciliation pass.

At no stage should a template migration alter the underlying business decision or execution logic.
