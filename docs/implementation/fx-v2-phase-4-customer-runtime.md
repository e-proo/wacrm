# FX V2 Phase 4 — customer AI/runtime tools

Status: implemented on `test/ai-runtime-kb-tools-v2`, verified by repository CI, and migration `081_fx_v2_customer_runtime_tools` applied/verified on TEST/STAGING only.

## Goal

Phase 4 moves customer-facing exchange-rate reads and trade-request creation from the legacy rate-book/customer-intent path onto the deterministic FX V2 domain built in Phases 1–2.

The customer runtime now has one authoritative path for current FX facts:

```text
customer message
  -> exchange_rates.get_current
  -> FX V2 pair + immutable current version
  -> customer confirms amount/side
  -> exchange_rates.record_trade_request@2
  -> createFxTradeRequest
  -> create_exchange_trade_request_v2 RPC
  -> exchange_trade_requests.pending_admin
```

No model calculation, conversation-history rate, KB rate, generic customer intent, or legacy Rate Book is authoritative in that flow.

## Current-rate tool

Tool: `exchange_rates.get_current@1`

Executor: `src/lib/ai/tools/fx-v2-tools.ts`

The tool now:

- reads `getCurrentFxRate` from `src/lib/services/fx-v2/service.ts`;
- resolves an explicit directional BASE/QUOTE pair;
- maps `customer_buys_base` to the business sell rate;
- maps `customer_sells_base` to the business buy rate;
- returns the effective customer rate plus the immutable `rate_version_id`, version number and publication time;
- treats legacy `region` / `settlement` inputs as non-pricing context only;
- never reads legacy exchange-rate books.

The returned `rate_version_id` is the quote token required by a later trade-request submission.

## Freshness guard

Files:

- `src/lib/ai/runtime/fx-current-rate-guard.ts`
- `src/lib/ai/runtime/agent-loop.ts`

Concrete/current FX questions are detected conservatively from FX/rate language plus a currency reference. Coverage/commission language is excluded because it has a separate authoritative pricing tool.

When a fresh FX rate is required:

1. the runtime requires `exchange_rates.get_current` to be available;
2. if it is not available, the turn fails closed instead of quoting history/KB;
3. the provider is first offered the authoritative rate tool;
4. if it attempts to answer without the tool, the runtime performs a forced-tool retry;
5. if the provider still refuses to call it, the runtime returns a safe no-rate response rather than a number;
6. the freshness requirement is satisfied only after a successful tool result.

This makes conversation history and retrieved knowledge explicitly non-authoritative for live FX prices.

## Customer trade-request tool

Tool: `exchange_rates.record_trade_request@2`

The v2 contract requires:

- explicit base and quote currencies;
- customer buy/sell side;
- confirmed positive base amount;
- the exact `expected_rate_version_id` returned by `exchange_rates.get_current`.

The executor also requires server-bound customer identity from the runtime:

- `contactId`;
- `conversationId`;
- `sourceMessageId`.

The model cannot choose or override those values.

Before mutation, the executor reads the current V2 rate and rejects a missing or stale quoted version. The Phase 2 RPC repeats the version check transactionally, so a rate change between application validation and database mutation is also rejected.

The request is then created through `createFxTradeRequest` / `create_exchange_trade_request_v2`, which snapshots:

- exact pair;
- exact immutable rate version;
- effective customer rate;
- base amount;
- quote amount;
- customer side.

The resulting lifecycle state is `pending_admin`. It is not approval and is never settlement completion.

The idempotency key binds the request to the source message, pair, side, amount and quoted version, making exact runtime retries safe.

## Grant migration

Migration: `supabase/migrations/081_fx_v2_customer_runtime_tools.sql`

`exchange_rates.record_trade_request` was bumped from version 1 to version 2 because the financial contract now requires an exact quoted `rate_version_id`.

The migration upgrades existing frozen grants from v1 to v2 without changing their permission: the tool remains `propose` and customer-plane only.

TEST/STAGING verification after applying migration 081:

```text
exchange_rates.get_current          @1 read     20 grants
exchange_rates.record_trade_request @2 propose  12 grants
```

No `exchange_rates.record_trade_request@1` grants remain on the TEST project.

## Tests and CI

Coverage includes:

- deterministic customer buy/sell side mapping;
- authoritative V2 current-rate output;
- real `pending_admin` V2 trade-request creation;
- server-bound customer identity;
- mandatory quoted rate version;
- stale quoted-version rejection;
- current-rate freshness detection;
- agent-loop fail-closed freshness behavior;
- tool-contract/version checks;
- grant-plane and authorization-policy checks.

The final branch CI passed lint, typecheck, tests and build. The migrations workflow also replayed all migrations from a clean database, verified the resulting schema, and reran the Phase 2 transactional FX smoke successfully.

## Deliberately left for Phase 5

Phase 4 does not migrate the admin FX tools. These remain legacy until their dedicated approval-boundary migration:

- `exchange_rates.admin_list_books`
- `exchange_rates.propose_pair_change`

Phase 5 replaces those book-centric operations with pair-centric FX V2 reads and typed admin proposals, and adds pending trade-request review/decision tools.
