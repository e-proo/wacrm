# FX V2 Phase 2 — deterministic domain services

Status: implemented on `test/ai-runtime-kb-tools-v2` and applied/verified on TEST/STAGING only.

## Goal

Phase 2 makes FX calculations and mutations deterministic before any dashboard or AI tool is migrated. The financial truth now lives in explicit domain functions and transactional database RPCs, not in model reasoning.

Phase 2 builds on migration `079_fx_v2_schema.sql` and adds migration `080_fx_v2_domain_rpcs.sql` plus `src/lib/services/fx-v2`.

## Stable direction rule

Every pair is directional: BASE/QUOTE means one BASE unit is priced in QUOTE units.

- `business_buy_rate`: business buys BASE from the customer.
- `business_sell_rate`: business sells BASE to the customer.
- `customer_sell`: uses `business_buy_rate`.
- `customer_buy`: uses `business_sell_rate`.

No automatic inverse or cross-rate synthesis is performed.

## Application calculation engine

File: `src/lib/services/fx-v2/engine.ts`

The engine is pure code and has no database or AI dependency. It:

- maps customer side to the correct business side;
- supports requests stated in BASE or QUOTE amount;
- uses `decimal.js`, not JavaScript floating point;
- applies HALF_UP rounding at currency boundaries;
- respects each currency's `decimal_digits` setting;
- keeps the effective rate at 8 decimal places;
- rejects non-positive amounts/rates and amounts that round to zero.

Unit coverage is in `src/lib/services/fx-v2/engine.test.ts`.

## Domain service

File: `src/lib/services/fx-v2/service.ts`

Implemented primitives:

- `getFxBaseCurrency`
- `setFxBaseCurrency`
- `listFxPairs`
- `ensureFxPair`
- `resolveFxPair`
- `getCurrentFxRate`
- `getCurrentFxRateByPair`
- `quoteFxTrade`
- `publishFxRateVersion`
- `createFxTradeRequest`
- `decideFxTradeRequest`
- `completeFxTradeRequest`
- `cancelFxTradeRequest`

The service maps SQL `P0001` domain errors to typed `FxServiceError` codes so callers can distinguish conflicts, missing rates, idempotency collisions and invalid state.

## Atomic rate publication

RPC: `publish_exchange_rate_pair_version_v2`

Publication locks the pair row, checks:

- account ownership;
- pair active state;
- both currencies still active;
- expected `lock_version`;
- positive buy/sell rates;
- allowed source;
- optional change-request ownership.

It then assigns the next `version_number`, inserts an immutable `exchange_rate_versions` row, points the pair to that version and increments `lock_version` in one transaction.

A stale editor receives `FX_PAIR_VERSION_CONFLICT` rather than silently overwriting a newer rate.

When `source_change_request_id` is supplied, retries are idempotent for the same pair/rates/source and conflicting reuse is rejected.

## Atomic trade-request creation

RPC: `create_exchange_trade_request_v2`

The function:

1. checks idempotency first;
2. validates optional contact/conversation account ownership;
3. takes a shared lock on the pair so the current rate pointer cannot change during request creation;
4. optionally requires an `expected_rate_version_id` so a customer cannot unknowingly submit against a rate different from the one just quoted;
5. chooses sell rate for `customer_buy` and buy rate for `customer_sell`;
6. calculates BASE/QUOTE amounts using currency decimal precision;
7. snapshots the exact version, effective rate and both amounts into `exchange_trade_requests`;
8. returns an existing request on an exact idempotent retry;
9. rejects reuse of the same idempotency key for different business input.

The resulting request starts in `pending_admin`.

## Lifecycle operations

`decide_exchange_trade_request_v2` supports:

- `approve` -> `approved_for_contact`
- `reject` -> `rejected`

Approval deliberately does **not** mean settlement completed.

`complete_exchange_trade_request_v2` only accepts `approved_for_contact -> completed`.

`cancel_exchange_trade_request_v2` accepts pending or approved-for-contact requests and moves them to `cancelled`.

All critical mutations append service activity events.

## Security boundary

All Phase 2 mutation RPCs are `SECURITY DEFINER`, have an explicit `search_path`, revoke execution from `public`, `anon` and `authenticated`, and grant execution only to `service_role`.

The browser/UI therefore cannot bypass the domain service and directly publish versions or create/transition trade requests.

## TEST/STAGING verification

Migration `fx_v2_domain_rpcs` was applied to project `wacrm test` only.

A transactional smoke test executed and then rolled back this sequence:

```text
configure FX base currency
create SAR/YER pair
publish V1: business buy 425 / business sell 428
verify stale pair lock is rejected
create customer_buy request for 1000 SAR
verify snapshot uses 428 and produces 428000 YER
retry same idempotency key and verify same request is returned
approve request -> approved_for_contact
complete request -> completed
publish V2: 426 / 429
try to create against V1 and verify FX_RATE_VERSION_CONFLICT
ROLLBACK
```

After rollback, `account_exchange_settings`, `exchange_rate_pairs`, `exchange_rate_versions` and `exchange_trade_requests` were all verified at zero rows. No test fixture was left behind.

## CI schema contract

`supabase/ci/verify-schema.sql` now asserts that all four V2 tables and all five Phase 2 RPCs exist after replaying migrations from a clean database.

## Deliberately not migrated yet

Phase 2 does not switch the existing UI or AI tools. In particular, legacy book-based functions under `src/lib/services/rates` and existing `exchange_rates.*` agent tools still use the legacy model until their dedicated rollout phases.

This avoids a half-migrated runtime where some callers read books and others mutate V2.

## Next phase

Phase 3 builds the dedicated FX dashboard against these services: settings, currencies, pairs/current rates, immutable rate history and trade-request queues. Only after that UI is stable should customer/admin AI tools be pointed at V2.
