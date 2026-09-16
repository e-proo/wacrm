# FX V2 Phase 1 — persistence foundation

Status: **implemented and applied to TEST/STAGING on 2026-09-16**

Branch: `test/ai-runtime-kb-tools-v2`

Migration: `supabase/migrations/079_fx_v2_schema.sql`

Supabase migration name: `fx_v2_schema`

## Goal

Phase 1 establishes the durable pair-centric FX data model. It intentionally does **not** switch customer/admin runtime tools, build the dashboard, or delete the legacy rate-book model. Those operations depend on later phases.

## Pre-implementation findings

The existing `currencies` table was inspected in code and TEST before designing the migration. It is already tenant-scoped by `account_id` and contains:

- code;
- display name;
- `active/disabled` status;
- kind;
- decimal digits;
- symbol;
- audit fields;
- account-member/admin RLS.

Because of that, the originally proposed `account_currencies` table was removed from the design. V2 references `currencies` directly.

TEST was also checked before Phase 1. At that point:

- `currencies`: 4 rows;
- `exchange_rate_books`: 0 rows;
- `exchange_rate_book_versions`: 0 rows;
- legacy `exchange_rates`: 0 rows;
- `exchange_rate_history`: 0 rows.

There was therefore no live legacy rate data to migrate during Phase 1.

## Schema created

### `account_exchange_settings`

One optional configuration row per account.

Key fields:

- `account_id` — primary key;
- `base_currency_id` — the account's FX default/base currency;
- created/updated actor and timestamps.

The `(account_id, base_currency_id)` foreign key points to the same account's `currencies` row. A separate setting is used instead of `accounts.default_currency` because CRM/deal display currency and FX conversational base currency are different concerns.

No setting row is auto-created. This prevents the migration from guessing that an account's CRM default currency is also its intended FX base currency.

### `exchange_rate_pairs`

The pair itself is the primary mutable FX object.

Key fields:

- `account_id`;
- `base_currency_id`;
- `quote_currency_id`;
- `status = active | archived`;
- `current_rate_version_id`;
- `lock_version` for optimistic concurrency;
- audit fields.

Important database invariants:

- base and quote currencies cannot be the same;
- both currencies must belong to the same account as the pair;
- one `(base, quote)` pair can exist only once per account;
- the current-rate pointer may only reference a version belonging to that exact pair;
- authenticated users cannot delete pairs; historical pairs are archived instead.

V2 does not implicitly create inverse pairs.

### `exchange_rate_versions`

Published rate rows are append-only through the authenticated application boundary and act as the rate history.

Key fields:

- `pair_id` and `account_id`;
- positive `version_number`;
- positive `business_buy_rate`;
- positive `business_sell_rate`;
- source: `manual | admin_agent | external | migration`;
- optional `source_change_request_id`;
- publication/audit metadata.

Important invariants:

- `(pair_id, version_number)` is unique;
- pair/account ownership is enforced with a composite foreign key;
- a source change request can be associated with at most one new rate version;
- authenticated clients receive SELECT only; publication/mutation is reserved for deterministic server-side work added in Phase 2.

A hard DELETE-blocking trigger was intentionally **not** used because it would interfere with legitimate account deletion/cascade behavior. Immutability is enforced at the application/security boundary by exposing no authenticated UPDATE/DELETE path and by treating publication as insertion of a new version.

### `exchange_trade_requests`

This is the real customer FX request entity that later replaces the generic `customer_intent` representation for exchange trades.

Key fields:

- global numeric `code` suitable for a future `FX-<code>` reference;
- `account_id` and `pair_id`;
- `side = customer_buy | customer_sell`, always relative to pair base currency;
- `amount_basis = base | quote`;
- `requested_amount`;
- exact `rate_version_id` snapshot;
- exact `effective_rate` snapshot;
- calculated `base_amount` and `quote_amount` snapshots;
- lifecycle state;
- account-scoped `idempotency_key`;
- optional contact/conversation linkage;
- optional admin `decision_change_request_id` and decision metadata;
- timestamps/metadata.

Lifecycle vocabulary created in Phase 1:

```text
pending_admin
approved_for_contact
rejected
completed
cancelled
```

`approved_for_contact` is deliberately different from `completed`: admin approval means the business accepted the request for follow-up, not that a financial settlement already happened.

Rate semantics are fixed for later domain logic:

```text
customer_buy  -> business_sell_rate
customer_sell -> business_buy_rate
```

## Security and tenant isolation

All four V2 tables have RLS enabled.

Policies after migration:

- `account_exchange_settings`: member SELECT; admin INSERT/UPDATE/DELETE;
- `exchange_rate_pairs`: member SELECT; admin INSERT/UPDATE; no authenticated DELETE;
- `exchange_rate_versions`: member SELECT only;
- `exchange_trade_requests`: member SELECT only.

Anon access is explicitly revoked from all V2 tables.

`service_role` receives the privileges required for deterministic server-side operations. Authenticated direct writes are intentionally withheld from rate versions and trade requests so later runtime operations cannot bypass the domain-service boundary.

## Indexing and idempotency

Phase 1 adds indexes for:

- account/status pair reads;
- base/quote currency pair lookup;
- pair rate history ordered by publication time;
- pending/status trade-request queues;
- pair/contact/conversation trade-request history;
- change-request idempotency for rate publication/decisions;
- account-scoped trade-request idempotency.

## Legacy coexistence

Phase 1 does not drop, rename or mutate the business behavior of:

- `exchange_rate_books`;
- `exchange_rate_book_versions`;
- legacy `exchange_rates`;
- `exchange_rate_history`.

The old runtime can therefore continue to start while later phases are implemented. Legacy deletion is postponed until runtime/UI/tool references are proven to be zero.

## TEST/STAGING verification performed

Migration `fx_v2_schema` was applied successfully to TEST project `wacrm test`.

Post-apply catalog verification confirmed the expected primary keys, checks, composite foreign keys and the critical current-version constraint:

```text
exchange_rate_pairs(id, current_rate_version_id)
  -> exchange_rate_versions(pair_id, id)
```

RLS verification confirmed:

```text
account_exchange_settings  RLS=true  policies=4
exchange_rate_pairs        RLS=true  policies=3
exchange_rate_versions     RLS=true  policies=1
exchange_trade_requests    RLS=true  policies=1
```

A transactional smoke test was then executed on TEST and rolled back. It successfully performed this complete persistence flow:

```text
configure FX base currency = YER
        ↓
create explicit SAR/YER pair
        ↓
insert published version #1
business buy = 425
business sell = 428
        ↓
point pair to version #1 and increment lock_version
        ↓
create customer_buy request
1000 SAR @ 428 = 428000 YER
        ↓
verify status = pending_admin
        ↓
ROLLBACK
```

The smoke test left no permanent test pair, rate version, setting or trade request.

## What Phase 1 deliberately does not do

Phase 1 does not yet:

- publish rates through an application RPC/domain service;
- calculate customer quotes in TypeScript;
- configure a real account FX base currency;
- add production rate data;
- modify customer AI tools;
- modify admin AI tools;
- create the FX dashboard;
- create FX messaging templates/events;
- create an exchange service in the service catalog;
- switch any runtime read from the legacy tables;
- delete legacy tables.

This boundary is intentional: Phase 1 is the persistence/security foundation only.

## Exact continuation point — Phase 2

Start Phase 2 from `exchange_rate_pairs` + `exchange_rate_versions`, not from legacy rate books.

The first implementation slice should create deterministic domain primitives for:

1. resolving the configured FX base currency;
2. resolving an explicit pair by account and currency codes/ids;
3. reading the authoritative current version;
4. publishing a new version atomically with `lock_version` conflict protection and change-request idempotency;
5. applying the fixed buy/sell direction rule;
6. quoting base-basis and quote-basis amounts with currency-aware rounding;
7. creating an idempotent snapshotted trade request;
8. unit/integration tests for all of the above.

Only after those primitives are green should the dashboard or AI tools be moved to V2.
