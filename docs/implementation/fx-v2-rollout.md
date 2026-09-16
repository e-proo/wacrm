# FX V2 rollout plan

Status: active implementation plan

This document is the canonical rollout map for replacing the legacy exchange-rate-book model with a simpler pair-centric FX domain.

## Why V2 exists

The legacy model is centered on `exchange_rate_books -> exchange_rate_book_versions -> exchange_rates`, with region/channel/settlement/staleness concerns attached to a book. That model is more general than the current product needs and makes basic questions such as “what is SAR/YER now?” depend on an unnecessary book layer.

FX V2 makes the currency pair the primary business object:

```text
account currency catalog
        ↓
FX account settings (base/default counter currency)
        ↓
explicit currency pair
        ↓
immutable published rate versions
        ↓
customer trade requests with rate snapshots
```

The legacy FX tables are not deleted during the rollout. Runtime code is migrated first; cleanup is a separate final phase after references reach zero.

## Important discovery made before Phase 1

`public.currencies` is already account-scoped (`account_id`) and already supports `active/disabled`, decimal digits, symbols and account RLS. Therefore FX V2 **reuses `currencies` directly**. The earlier idea of a separate `account_currencies` table was dropped because it would duplicate existing state.

`accounts.default_currency` is also **not** reused as the FX base currency. It controls CRM/deal display defaults and is a different business concern. FX gets its own `account_exchange_settings.base_currency_id`.

## Stable business semantics

A pair is explicit and directional. `SAR/YER` is not automatically equivalent to `YER/SAR`; V2 does not generate inverse or cross rates unless a later product requirement explicitly adds that behavior.

`business_buy_rate` means the business buys the pair's **base currency** from the customer. `business_sell_rate` means the business sells the pair's **base currency** to the customer.

Therefore:

- `customer_sell` uses `business_buy_rate`.
- `customer_buy` uses `business_sell_rate`.

The account FX base currency is only a default counter currency for conversational resolution. Changing it never rewrites existing pairs, versions or trade history.

## Phase 1 — Pair-centric persistence foundation

Status: **implemented on the test branch and applied to TEST/STAGING**.

Migration: `supabase/migrations/079_fx_v2_schema.sql`

Creates:

- `account_exchange_settings`
- `exchange_rate_pairs`
- `exchange_rate_versions`
- `exchange_trade_requests`

Reuses:

- `currencies`
- `accounts`
- `contacts`
- `conversations`
- `change_requests`
- account membership/RLS infrastructure

Phase 1 establishes tenant-safe composite foreign keys, unique pair identity, positive-rate/amount checks, current-version ownership, optimistic `lock_version`, idempotent trade-request keys, lifecycle vocabulary, RLS and explicit grants.

Detailed implementation and verification are recorded in `docs/implementation/fx-v2-phase-1-schema.md`.

## Phase 2 — Deterministic FX domain services

Status: **implemented on the test branch and applied/verified on TEST/STAGING**.

Migration: `supabase/migrations/080_fx_v2_domain_rpcs.sql`

Application layer: `src/lib/services/fx-v2/`

Implemented work:

- configure/read the account FX base currency;
- list, create/reactivate and resolve explicit currency pairs;
- fetch the authoritative current rate and immutable version;
- atomically publish a new rate version with optimistic concurrency;
- map `customer_buy/customer_sell` to the correct business buy/sell rate;
- quote from either `base` or `quote` amount basis with deterministic decimal rounding;
- create an idempotent `exchange_trade_request` with exact rate/version snapshots;
- reject submission when the quoted expected rate version is no longer current;
- transition trade requests through pending -> approved/rejected -> completed/cancelled lifecycle operations;
- attach admin decisions to optional `change_requests` without treating approval as settlement completion;
- append activity events for critical mutations;
- unit-test direction and rounding and integration-smoke-test stale versions/idempotency on TEST.

No AI tool performs these calculations independently.

Detailed implementation and verification are recorded in `docs/implementation/fx-v2-phase-2-domain-services.md`.

## Phase 3 — FX dashboard

Status: **next**.

Add a dedicated FX area rather than hiding FX configuration inside generic settings/services.

Primary views:

- Rates: active pairs, current buy/sell values and last publication.
- Currencies: reuse account-scoped `currencies`.
- FX settings: configure the FX base currency.
- Trade requests: pending/approved/rejected/completed/cancelled.
- Rate history: immutable versions per pair.

User-facing UI should not expose legacy concepts such as “Rate Book” or “Book Version”.

## Phase 4 — Customer AI/runtime tools

Status: planned.

Migrate customer-facing FX tools to V2 domain services.

Expected contracts:

- `exchange_rates.get_current` remains conceptually available but becomes pair/base-currency aware and always reads the authoritative current V2 rate.
- `exchange_rates.record_trade_request` stops producing a generic `customer_intent`; it creates a real `exchange_trade_request` through the deterministic Phase 2 service.

Concrete rate questions must not be answered from conversation history or KB content when a current DB rate is required.

## Phase 5 — Admin agent tools and approvals

Status: planned.

Replace book-centric admin operations with pair-centric operations.

Expected direction:

- replace `exchange_rates.admin_list_books` with pair-oriented reads;
- keep the intent of `exchange_rates.propose_pair_change`, but target `pair_id + expected lock/version + business buy/sell rates`;
- add pending trade-request reads and propose approve/reject decisions;
- route AI-originated writes through the existing trusted-admin/change-request approval boundary;
- keep `rates.read` and `rates.propose` capabilities as the authorization vocabulary unless implementation proves a narrower split is needed.

Approval of a customer trade request means `approved_for_contact`; it does **not** mean money was exchanged. `completed` must require a separate authoritative business action/state transition.

## Phase 6 — Messaging and full E2E acceptance

Status: planned.

Connect FX events to the existing Business Event -> MessageContext -> Template Resolver -> Renderer -> Transport platform.

At minimum cover:

- trade request received/pending;
- approved for contact;
- rejected;
- completed, only when an authoritative completed state exists.

Templates must display the snapshotted pair, side, amount and effective rate deterministically. The LLM must not rewrite transactional rate facts.

E2E acceptance must cover both customer directions:

- customer buys base currency -> business sell rate;
- customer sells base currency -> business buy rate.

## Phase 7 — Legacy FX cleanup

Status: deferred until all previous phases are accepted.

Only after runtime/UI/tools no longer reference the old model:

- remove/deprecate `exchange_rate_books`;
- remove/deprecate `exchange_rate_book_versions`;
- remove/deprecate legacy `exchange_rates`;
- remove/deprecate `exchange_rate_history`;
- remove legacy book publication RPCs and book-centric runtime code;
- remove `exchange_rates.admin_list_books` and obsolete schemas/tests.

Before destructive cleanup, prove code references are zero and repeat migration/CI/E2E verification on TEST/STAGING.

## Non-goals for the initial V2 rollout

The initial V2 deliberately does not add automatic inverse rates, cross-rate synthesis, pricing tiers, spreads/rules engines, region-specific books, settlement-method books, or automatic staleness windows. These can be added later only if a real product requirement justifies them.

## Rollout safety rules

- Develop and verify on `test/ai-runtime-kb-tools-v2`.
- Apply migrations to TEST/STAGING before any production consideration.
- Do not delete legacy tables while old runtime references remain.
- Persist exact rate/version snapshots on customer trade requests.
- Use optimistic concurrency for rate publication.
- Keep rate publication and trade-state mutation deterministic and server-side.
- Treat immutable version rows as history; publish a new version instead of editing an old one.
