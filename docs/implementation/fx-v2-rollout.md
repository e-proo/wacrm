# FX V2 rollout plan

Status: **Phases 1-7 implemented and verified on the test branch and TEST/STAGING. Production rollout is not part of this closure.**

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

Status: **implemented on the test branch, applied/verified on TEST/STAGING, and covered by automated migration CI**.

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
- unit-test direction and rounding;
- integration-smoke-test stale pair locks, exact idempotent retries, approval/completion lifecycle and stale quoted versions;
- assert the service-role-only RPC execution boundary.

The automated database smoke is `supabase/ci/fx-v2-phase-2-smoke.sql`. The migrations workflow runs it after replaying every migration from scratch on a clean local Supabase database. The smoke uses a disposable fixture, removes it on success, and a failed assertion rolls back the statement.

No AI tool performs these calculations independently.

Detailed implementation and TEST/STAGING verification are recorded in `docs/implementation/fx-v2-phase-2-domain-services.md`.

## Phase 3 — FX dashboard

Status: **implemented on the test branch and verified by repository CI**.

A dedicated `/fx` area now exposes the pair-centric domain without legacy Rate Book concepts.

Primary views:

- Rates: active pairs, current business buy/sell values, optimistic lock version, publication and immutable history.
- Currencies: reuse account-scoped `currencies`.
- FX settings: configure the FX base/default counter currency.
- Trade requests: pending/approved/rejected/completed/cancelled queues and allowed lifecycle actions.
- Rate history: immutable versions per pair.

Authorization behavior:

- `viewer+` can read FX state;
- `admin+` is required server-side for settings changes, pair creation, rate publication and trade-request transitions;
- the `/fx` UI mirrors that boundary by hiding mutation controls from read-only viewers, including currency-management controls.

Phase 3 uses the deterministic Phase 2 services and RPCs for financial writes. A stale rate editor receives the optimistic concurrency conflict instead of overwriting a newer rate.

Detailed implementation is recorded in `docs/implementation/fx-v2-phase-3-dashboard.md`.

## Phase 4 — Customer AI/runtime tools

Status: **implemented on the test branch, verified by repository CI, and migration 081 applied/verified on TEST/STAGING**.

Migration: `supabase/migrations/081_fx_v2_customer_runtime_tools.sql`

Customer runtime implementation: `src/lib/ai/tools/fx-v2-tools.ts`

Implemented work:

- `exchange_rates.get_current@1` now reads the authoritative current FX V2 pair/version instead of a legacy rate book;
- customer buy/sell direction is mapped through the deterministic Phase 2 engine;
- the read result returns the exact immutable `rate_version_id` used as a later quote token;
- concrete/current FX questions are detected by a runtime freshness guard and cannot be answered from conversation history or KB content;
- if the authoritative current-rate tool is unavailable or the provider refuses the required call, the runtime fails closed rather than quoting a stale number;
- `exchange_rates.record_trade_request@2` requires the exact `expected_rate_version_id` returned by the preceding quote;
- missing or stale quoted versions are rejected before mutation and again transactionally by the Phase 2 RPC;
- customer identity is server-bound from contact/conversation/source-message context and cannot be chosen by the model;
- confirmed requests create real `exchange_trade_requests` in `pending_admin`, with exact pair/rate/amount snapshots and deterministic idempotency;
- customer FX requests no longer create generic `customer_intents`.

Migration 081 upgrades existing frozen `exchange_rates.record_trade_request@1` grants to the safer v2 contract while keeping the permission `propose`. On TEST/STAGING, all 12 existing record-trade grants were verified at v2 after migration; the 20 current-rate read grants remain at v1.

Detailed implementation and verification are recorded in `docs/implementation/fx-v2-phase-4-customer-runtime.md`.

## Phase 5 — Admin agent tools and approvals

Status: **implemented on the test branch, migrations 082 and 083 applied/verified on TEST/STAGING, and verified by final repository CI**.

Migrations:

- `supabase/migrations/082_fx_v2_admin_agent_tools.sql`
- `supabase/migrations/083_fx_v2_admin_grant_plane_cleanup.sql`

Admin runtime implementation: `src/lib/ai/tools/fx-v2-admin-tools.ts`

Implemented work:

- `exchange_rates.admin_list_books` is no longer a current registered/model-exposed tool;
- `exchange_rates.admin_list_pairs@1` exposes explicit FX V2 pairs, current immutable rates and optimistic `lock_version` values;
- `exchange_rates.propose_pair_change@2` targets `pair_id + expected_lock_version + business buy/sell rates` and creates a typed Change Request rather than writing directly;
- approved rate proposals execute through `publishFxRateVersion` / the Phase 2 publication RPC with the Change Request id attached as the source;
- stale rate proposals are rejected again transactionally after approval instead of overwriting a newer pair version;
- `exchange_rates.admin_list_trade_requests@1` exposes snapshotted FX V2 trade requests for operational review;
- `exchange_rates.propose_trade_decision@1` proposes only approve/reject decisions for `pending_admin` requests;
- approved trade decisions execute through `decideFxTradeRequest` / the Phase 2 decision RPC with `expected_status = pending_admin`;
- approval means `approved_for_contact`, not settlement completion;
- admin reads remain protected by `rates.read`, while proposal tools remain protected by `rates.propose` and the trusted-admin + human Change Request approval boundary;
- agent-tool UI labels are pair-centric and no longer present the obsolete Rate Book tool;
- migration 083 removes stale admin-only FX grants from non-`admin_operations` revisions as database-level defense in depth, while runtime plane/capability checks remain independently enforced.

Final TEST/STAGING grant state after 082 + 083:

```text
purpose: admin_operations
exchange_rates.admin_list_pairs          @1 read      5 grants
exchange_rates.admin_list_trade_requests @1 read      5 grants
exchange_rates.propose_pair_change       @2 propose   5 grants
exchange_rates.propose_trade_decision    @1 propose   5 grants

customer_support admin-only FX grants:   0
exchange_rates.admin_list_books grants:  0
```

Detailed implementation and verification are recorded in `docs/implementation/fx-v2-phase-5-admin-agent-tools.md`.

## Phase 6 — Messaging and full E2E acceptance

Status: **implemented on the test branch, migration 084 applied/verified on TEST/STAGING, and covered by final repository CI**.

Migration: `supabase/migrations/084_fx_v2_customer_lifecycle_outbox.sql`

Messaging implementation:

- `src/lib/messaging/domains.ts`
- `src/lib/messaging/fx-v2-customer.ts`
- `src/lib/ai/runtime/worker.ts`

Implemented work:

- FX V2 emits durable customer events for `pending`, `approved_for_contact`, `rejected`, and authoritative `completed` states;
- events are inserted transactionally with the authoritative `exchange_trade_requests` mutation, eliminating a mutation/outbox split-brain window;
- the existing customer notification outbox is extended instead of introducing a parallel messaging system;
- intent notifications and FX notifications are source-separated so the legacy intent claim path cannot steal FX rows;
- FX delivery reloads the frozen trade snapshot and pair currencies immediately before deterministic rendering;
- templates must retain trade reference, pair, side, requested amount/currency, effective rate, base amount/currency and quote amount/currency;
- invalid account overrides fall back to reviewed system copy rather than dropping financial truth;
- the LLM and KB never calculate or rewrite transactional FX facts;
- `approved_for_contact` explicitly remains distinct from `completed`;
- a completed customer event can be emitted only after the deterministic completion RPC places the authoritative request in `completed`;
- outbox dedupe guarantees one event per `(account, trade request, event)` across idempotent mutation retries;
- the existing transport idempotency/reconciliation boundary is reused.

E2E acceptance covers both directions:

- customer buys BASE -> `business_sell_rate`;
- customer sells BASE -> `business_buy_rate`.

`supabase/ci/fx-v2-phase-6-messaging-smoke.sql` verifies frozen amounts/rates, pending/approval/rejection/completion event sequencing, no premature completion event, event dedupe and isolation from the legacy intent claim path. The Migrations workflow executes this smoke after a clean migration replay.

Migration 084 was applied to TEST/STAGING as `20260916213821 / fx_v2_customer_lifecycle_outbox`. Direct post-apply TEST/STAGING verification confirmed the FX outbox column, source-entity constraint, dedupe index, lifecycle trigger and enqueue function. The intent claim RPC remains non-executable by `anon` and `authenticated` and executable by `service_role` only.

Detailed implementation and acceptance evidence are recorded in `docs/implementation/fx-v2-phase-6-messaging-e2e.md`.

## Phase 7 — Legacy FX cleanup

Status: **implemented on the test branch, applied/verified on TEST/STAGING, and covered by final repository CI**.

Migration: `supabase/migrations/085_fx_v2_legacy_cleanup.sql`

Acceptance smoke: `supabase/ci/fx-v2-phase-7-legacy-cleanup-smoke.sql`

Completed work:

- removed `exchange_rate_books`, `exchange_rate_book_versions`, legacy `exchange_rates`, and `exchange_rate_history`;
- removed the legacy publication, validation, pair-change, and updated-at functions;
- removed the obsolete book-centric HTTP routes, dashboard panel, services, executors, and tests;
- migrated the currency-disable reference guard to `exchange_rate_pairs`;
- retained the pair-centric FX V2 persistence and deterministic RPC boundary;
- added a runtime regression contract that rejects legacy imports/routes while preserving unrelated coverage handoffs;
- added a fail-closed migration guard for legacy rows, Change Requests, and agent grants;
- added clean-replay CI verification for the Phase 7 postconditions plus the surviving Phase 2 and Phase 6 behavior.

Repository verification at closure:

- lint: passed (warnings only, no errors);
- typecheck: passed;
- tests: 138 files / 1417 tests passed;
- production build: passed, 88/88 routes generated;
- migrations workflow: clean replay and Phase 2/6/7 smokes passed.

TEST/STAGING verification:

- migration recorded as `20260916232809 / fx_v2_legacy_cleanup`;
- all four legacy tables resolve to absent;
- all four legacy functions resolve to absent;
- `account_exchange_settings`, `exchange_rate_pairs`, `exchange_rate_versions`, and `exchange_trade_requests` remain present;
- the Phase 7 acceptance smoke completed successfully.

No Phase 7 migration or destructive cleanup was applied to production.

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
