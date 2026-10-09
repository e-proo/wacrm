# Message Template Development Guide

This guide explains how to add or customize transactional messaging without coupling a service to WhatsApp text.

## Core rule

A domain must provide **facts**, not prose.

Good:

```ts
{
  eventKey: 'exchange_rate.trade.approved',
  context: {
    entity: { type: 'exchange_trade', reference: 'FX-104' },
    money: { amount: '10,000', currency: 'SAR' },
    data: { side_label: 'شراء', rate: '425' }
  }
}
```

Avoid:

```ts
{ message: 'تم شراء 10,000 ريال سعودي بسعر 425' }
```

The first form can be rendered differently for customer/admin, WhatsApp/in-app, Arabic/English, and future channels.

## Adding a new business event

1. Choose a stable event key independent from implementation details.
2. Build a `MessageContext` using reserved roots.
3. Decide whether generic lifecycle fallback is sufficient.
4. Add a specialized system template only when the domain needs additional detail.
5. Add renderer/resolver tests.
6. Wire transport only after the business operation is already deterministic and idempotent.

Example future service:

```text
bill_payment.approved
```

Without any new template it can fall back to:

```text
service_request.approved
```

Later, add `bill_payment.approved` to `SYSTEM_MESSAGE_TEMPLATES` for richer copy.

## Template syntax

Scalar variable:

```text
{{entity.reference}}
```

Optional block:

```text
{{#if data.destination}}الوجهة: {{data.destination}}{{/if}}
```

Transient secret:

```text
{{secret.confirmation_code}}
```

Secret placeholders are rejected unless their key is declared in `secretVariables`.

## Variable rules

- Variables use dotted paths.
- Directly rendered values must be scalar (`string`, `number`, `boolean`).
- Required variables fail closed when missing.
- Optional values should normally appear inside `#if` blocks.
- Do not render raw objects or arrays.
- Do not put database table/column names in template paths.
- Format money/rates/dates before rendering or through a reviewed domain formatter.

## Adding a system template

Edit:

```text
src/lib/messaging/defaults.ts
```

Example:

```ts
{
  key: 'bill_payment.approved',
  audience: 'customer',
  channel: 'whatsapp',
  locale: 'ar',
  body: [
    '✅ تم سداد الفاتورة.',
    'المرجع: {{entity.reference}}',
    'المبلغ: {{money.amount}} {{money.currency}}',
    '{{#if data.biller_name}}الجهة: {{data.biller_name}}{{/if}}',
  ].join('\n'),
  requiredVariables: ['entity.reference', 'money.amount', 'money.currency'],
  optionalVariables: ['data.biller_name'],
}
```

## Account-specific override lifecycle

Create a revision through:

```text
create_message_template_revision(...)
```

Validate/preview it in application code using the same renderer used at runtime.

Publish it through:

```text
publish_message_template_revision(account_id, revision_id)
```

Publishing changes only the pointer in `message_template_publications`.

Rollback by publishing a previous revision id. Unpublish to restore repository system defaults.

## Publishing checklist

Before publishing an account override verify:

- template key is valid
- audience/channel/locale are correct
- every required variable is available for that event
- all secret placeholders are explicitly declared
- no secret value is stored in body, metadata, or context examples
- output length fits the target channel
- customer copy exposes only customer-safe data
- admin copy does not expose internal stack errors
- preview succeeds against representative context fixtures
- generic fallback still exists if the override is unpublished

## Coverage adapter

Use `buildCoverageMessageContext`.

The caller must provide the already-authoritative direction semantics. For Yemen coverage:

- SOUTH -> NORTH offer: commission effect is `customer_receives`
- NORTH -> SOUTH request: commission effect is `customer_pays`

The context builder turns this into a presentation label; it must not independently decide direction from prose.

## Exchange-rate adapter

Use `buildExchangeRateMessageContext` for quote display.

Buy/sell rates must originate from the published rate service/tool. Do not cache a current price in a template, KB entry, or prompt.

For trade approval, extend the generic service context with `side_label`, authoritative `rate`, and transaction reference.

## Remittance adapter

Use `buildRemittanceMessageContext` for completed transfer outcomes.

Only emit `remittance.completed` after the deterministic remittance operation has actually completed. If the provider state is ambiguous, emit/retain a reconciliation state instead of claiming completion.

## Admin vs customer templates

The same business event may have distinct templates by audience:

```text
change_request.approved + admin + whatsapp
change_request.approved + customer + whatsapp
change_request.approved + admin + in_app
```

Do not reuse admin copy for customers. Admin messages may contain operational references and action guidance; customer copy should remain service-oriented and safe.

## Locale strategy

Request the most specific locale available, e.g. `ar-YE`.

Resolver fallback is:

```text
ar-YE -> ar
```

The default Arabic templates ensure service continuity even if no tenant-specific locale exists.

## Testing

Minimum tests for every new template family:

1. successful render with complete context
2. required variable missing -> fail closed
3. optional block absent -> no broken placeholder
4. account override wins over system default
5. locale fallback works
6. future service generic fallback works where intended
7. secret placeholder cannot render unless declared
8. channel length limit is enforced

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Operational logging

Log template metadata, not rendered secrets:

```text
event_key
resolved_template_key
source
revision_id/version
channel
audience
locale
entity_id/reference
transport idempotency key
```

Never log the `secrets` map.

## When to use Knowledge Base instead

Use KB when the user asks explanatory questions such as:

- What is an offer vs request?
- What does buy vs sell mean?
- What documents are needed for a remittance?
- How does a service work?

Use templates when the system is reporting a known operational event such as:

- approved
- rejected
- completed
- current quote returned from an authoritative tool
- transaction created
- admin action required

The template may present facts; it must never invent them.
