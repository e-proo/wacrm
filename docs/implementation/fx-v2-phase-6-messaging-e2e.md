# FX V2 Phase 6 — Messaging and E2E acceptance

Status: **implemented on the test branch, migration 084 applied/verified on TEST/STAGING, and covered by repository CI**.

## Scope

Phase 6 connects authoritative FX V2 trade lifecycle state to the existing messaging platform:

```text
Business Event -> MessageContext -> Template Resolver -> Renderer -> Transport
```

No parallel notification stack was introduced. The existing durable customer notification outbox, renderer, WhatsApp transport, idempotency reservation, retry/reconciliation behavior and account template override store are reused.

## Migration

`supabase/migrations/084_fx_v2_customer_lifecycle_outbox.sql`

The migration extends the historical `customer_intent_notifications` outbox so a row belongs to exactly one source entity:

- `customer_intent`, or
- `exchange_trade_request`.

It adds `fx_trade_request_id`, keeps legacy intent behavior compatible, and adds an FX-specific unique key on:

```text
(account_id, fx_trade_request_id, event_type)
```

This guarantees one durable lifecycle event per trade/event even when the underlying domain mutation is retried idempotently.

The lifecycle event is inserted by a database `AFTER INSERT/UPDATE` trigger on `exchange_trade_requests`. Because the outbox insert occurs in the same PostgreSQL transaction as the authoritative trade mutation, a successful trade transition cannot commit while silently losing its corresponding lifecycle event.

The existing intent-specific atomic claim RPC is explicitly narrowed to `fx_trade_request_id is null`, so old change-request delivery code cannot claim or send an FX row before the FX renderer has loaded its financial snapshot.

## Stable FX customer events

Phase 6 defines four explicit customer-facing event keys:

- `exchange_rate.trade.pending`
- `exchange_rate.trade.approved_for_contact`
- `exchange_rate.trade.rejected`
- `exchange_rate.trade.completed`

The state distinction is intentional:

- `approved_for_contact` means the business approved the request for customer contact/follow-up;
- it does **not** mean settlement completed;
- the `completed` event is emitted only after the authoritative trade row reaches `status = completed` through the deterministic Phase 2 completion RPC.

## Deterministic financial message context

`src/lib/messaging/domains.ts` now exposes `buildFxTradeMessageContext`.

`src/lib/messaging/fx-v2-customer.ts` renders FX trade lifecycle messages using only the frozen trade snapshot and pair currencies. It does not call an LLM, a knowledge base, or the current-rate service at delivery time.

Every FX V2 customer template is required to retain these financial placeholders:

- trade reference;
- explicit pair;
- customer side/direction;
- requested amount and its currency;
- effective snapshotted rate;
- base amount and base currency;
- quote amount and quote currency.

An account override that removes a required financial fact, requests secrets, or targets the wrong surface is rejected by the adapter and falls back to the reviewed system template. Emergency copy is also constructed only from the authoritative snapshot.

This prevents later rate publications, KB content, conversation history or model prose from rewriting the financial facts of an existing request.

## Transport and delivery

`src/lib/ai/runtime/worker.ts` reuses the existing customer notification worker.

For FX rows, the worker:

1. claims the durable outbox row with the existing CAS/retry boundary;
2. loads the referenced `exchange_trade_requests` row;
3. loads the pair's base/quote currency codes;
4. verifies that the outbox event matches the authoritative trade status;
5. renders the message through `renderFxTradeCustomerMessage` and the existing Supabase template override store;
6. sends through `engineSendText`;
7. uses the existing message reservation/idempotency and reconciliation behavior.

The persisted marker `__FX_V2_RENDER_AT_DELIVERY__` is never intended as customer copy. Rendering occurs at delivery from authoritative state.

## Direction semantics accepted

The Phase 6 integration smoke proves both directions against a published `SAR/YER` pair with:

```text
business_buy_rate  = 425
business_sell_rate = 428
```

### Customer buys BASE

`customer_buy` means the customer buys SAR from the business, therefore the business sell rate applies.

For a 1,000 SAR base request:

```text
effective_rate = 428
base_amount    = 1,000 SAR
quote_amount   = 428,000 YER
```

The smoke verifies that the pending event is emitted exactly once, an exact create retry does not duplicate it, approval emits `approved_for_contact`, no completed event exists before completion, and the completion RPC then emits exactly one `completed` event.

### Customer sells BASE

`customer_sell` means the customer sells SAR to the business, therefore the business buy rate applies.

For a 1,000 SAR base request:

```text
effective_rate = 425
base_amount    = 1,000 SAR
quote_amount   = 425,000 YER
```

The smoke verifies that rejection emits exactly one `exchange_rate.trade.rejected` event.

## Automated acceptance coverage

Repository coverage added in Phase 6:

- `src/lib/messaging/fx-v2-customer.test.ts`
  - customer-buy/customer-sell rendering semantics;
  - lifecycle wording separation;
  - financial placeholder requirements;
  - safe fallback behavior for invalid account overrides.
- `supabase/ci/fx-v2-phase-6-messaging-smoke.sql`
  - customer-buy -> business sell rate;
  - customer-sell -> business buy rate;
  - frozen financial snapshots;
  - pending/approved-for-contact/rejected/completed lifecycle events;
  - no premature completed event;
  - outbox idempotency on trade retry;
  - legacy intent claim isolation from FX rows.
- `supabase/ci/verify-schema.sql`
  - Phase 6 outbox column/index/trigger assertions.
- `.github/workflows/migrations.yml`
  - runs the Phase 6 messaging smoke after clean migration replay and Phase 2 smoke.

On repository commit `008ee5fa1d8ab7bdd443ec0c48dbb7b2a0a51055`, both GitHub Actions workflows completed successfully:

- CI run `35152214305` — success;
- Migrations run `35152214316` — success.

The Migrations workflow replayed all migrations on a clean database and executed the Phase 6 messaging smoke successfully.

## TEST/STAGING verification

Migration `fx_v2_customer_lifecycle_outbox` was applied to the TEST/STAGING Supabase project `wacrm test` (`pqirsnfupofhulmewakq`) as migration version `20260916213821`.

Post-apply read-only verification on TEST/STAGING confirmed:

- `customer_intent_notifications.fx_trade_request_id` exists and is nullable for legacy compatibility;
- `customer_intent_notifications_source_entity_check` exists;
- `customer_intent_notifications_fx_trade_once_uidx` exists;
- `exchange_trade_requests_customer_lifecycle_event` trigger exists;
- `enqueue_fx_trade_customer_lifecycle_event()` exists;
- `claim_customer_intent_notifications(...)` is **not** executable by `anon`;
- it is **not** executable by `authenticated`;
- it remains executable by `service_role`.

A direct execution of the fixture-heavy Phase 6 smoke through the connected SQL tool was blocked by the tool safety layer because the smoke creates/removes temporary `auth.users` fixtures. The identical smoke has already passed in the repository Migrations workflow against a clean Supabase database, while TEST/STAGING schema and security boundaries were verified directly after applying 084.

## Acceptance result

Phase 6 is accepted when all of the following hold, and they now do on the test branch / TEST/STAGING boundary:

- lifecycle events are durable and transactionally tied to authoritative FX transitions;
- `approved_for_contact` cannot be presented as completion;
- completion copy requires authoritative `completed` state;
- customer-buy uses the business sell rate;
- customer-sell uses the business buy rate;
- customer messages preserve the frozen trade snapshot;
- account template overrides cannot omit required financial truth;
- outbox events are idempotent;
- legacy intent notification delivery cannot steal FX rows;
- clean migration replay and repository CI are green;
- migration 084 is applied and schema/security boundaries are verified on TEST/STAGING.

No Production migration or production data change was performed in Phase 6.

## Next phase

Phase 7 is legacy FX cleanup. It remains gated on proving that no active runtime/UI/tool path still depends on the old rate-book model before any destructive deletion or deprecation is performed.
