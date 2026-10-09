# Messaging Phase 3 — Coverage Customer Outcomes

## Status

Implemented on `test/ai-runtime-kb-tools-v2` for TEST/STAGING validation.

This phase migrates approved coverage customer notifications from executor-owned hard-coded copy to the generic Messaging & Business Events Platform.

## Scope

Migrated events:

- `coverage.offer.approved`
- `coverage.request.approved`

The deterministic coverage executor remains authoritative for business classification and mutation.

## Architecture

The executor no longer stores final coverage copy in `customer_notification.message_text`.

Instead it returns a structured descriptor:

```text
customer_notification
  intent_id
  event_type
  template_event
  template_payload
```

The payload contains business facts only:

```text
kind
entity_id
reference
service_id
amount
currency
attributes
commission_per_thousand
commission_currency
```

After `complete_change_request_execution` succeeds, `enqueueCustomerNotification` renders the descriptor into `message_text` and inserts the durable customer outbox row.

This order is intentional:

```text
business mutation
  -> complete execution
  -> render customer outcome
  -> durable outbox
  -> WhatsApp delivery
```

A template/render failure therefore cannot roll back or falsely mark the already-applied business mutation as failed.

## Backward compatibility

`customer_notification.message_text` remains supported for message families that have not yet migrated.

This allows incremental adoption:

```text
legacy service -> message_text
migrated service -> template_event + template_payload
```

No big-bang conversion is required.

## Coverage semantics

Presentation uses the already-determined target kind; it never reclassifies direction from prose.

### Offer

Customer pays SOUTH and receives NORTH.

- event: `coverage.offer.approved`
- commission effect: `customer_receives`
- Arabic label: `الراجع لك`

### Request

Customer pays NORTH and receives SOUTH.

- event: `coverage.request.approved`
- commission effect: `customer_pays`
- Arabic label: `العمولة عليك`

Payment/receive methods are presentation fields only and do not alter offer/request classification.

## Commission calculation

Customer-facing commission amount is derived deterministically from the approved execution payload:

```text
amount * commission_per_thousand / 1000
```

The template never calculates or invents a rate.

`commission_currency` is carried separately from the principal currency so future services are not forced to assume both currencies are identical.

## Region presentation

Coverage attributes store region IDs. During outbox rendering the runtime resolves those IDs from `coverage_regions` for the same account and uses the authoritative region name/code.

Missing region labels degrade to an explicit non-fabricated fallback rather than an invented location.

## Method presentation

Stable method codes are mapped only for display:

- `cash` -> `نقدًا`
- `networks` -> `شبكات`
- `remittance` -> `حوالة`
- `bank_deposit` -> `إيداع بنكي`
- `any` -> `أي طريقة متاحة`

The method labels do not participate in business classification.

## Template safety

Coverage customer templates:

- must target `customer + whatsapp`
- must include amount and currency
- may not declare or reference secret variables
- use account override when valid
- fall back to reviewed system template when override is invalid/unavailable
- have a final deterministic emergency copy if even the system renderer becomes unavailable

## Observability

Expected system-template log:

```text
[messaging] event=coverage.offer.approved source=system template=coverage.offer.approved locale=ar channel=whatsapp
```

or:

```text
[messaging] event=coverage.request.approved source=system template=coverage.request.approved locale=ar channel=whatsapp
```

Account overrides include revision/version metadata without customer-sensitive or secret values.

## Expected offer example

```text
✅ تم اعتماد عرض التغطية الخاص بك
المرجع: ...
المبلغ: 100,000 SAR
الدفع: حضرموت — نقدًا
الاستلام: صنعاء — شبكات
الراجع لك: 700 SAR

أصبح العرض مسجلاً وجاهزًا للمعالجة.
```

## Expected request example

```text
✅ تم اعتماد طلب التغطية الخاص بك
المبلغ: 100,000 SAR
الدفع: صنعاء — نقدًا
الاستلام: عدن — شبكات
العمولة عليك: 700 SAR

تم إدراج الطلب للمعالجة.
```

## Test contract

Automated tests cover:

- offer wording and customer-receives commission semantics
- request wording and customer-pays commission semantics
- per-thousand commission arithmetic
- distinct commission currency
- method labels
- safe account override
- unsafe secret-bearing override fallback

## Rollback

Because no schema migration is required for this phase, rollback is code-only:

1. restore coverage descriptors to legacy `message_text`, or
2. unpublish an account template override to return immediately to the system template.

The durable outbox and delivery worker contracts remain unchanged.
