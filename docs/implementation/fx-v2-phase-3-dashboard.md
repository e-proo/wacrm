# FX V2 Phase 3 — dedicated dashboard

Status: implemented on `test/ai-runtime-kb-tools-v2`.

## Goal

Phase 3 removes the user-facing dependency on the legacy Rate Book UI and gives FX a dedicated operational area backed only by the deterministic V2 domain created in Phases 1-2.

The dashboard route is:

```text
/fx
```

It is linked directly from the main sidebar. The old FX tab was removed from `/services`; Services now provides only a transition link to the dedicated FX area. Legacy book code and APIs remain in the repository for compatibility until Phase 7, but they are no longer the primary UI.

## Dashboard surfaces

### Rates

The Rates tab shows explicit directional pairs such as `SAR/YER`.

For each pair it displays:

- current business buy rate;
- current business sell rate;
- current immutable rate version;
- optimistic `lock_version`;
- publication timestamp;
- rate history.

Admin users can create a pair and publish a new rate. Publication sends the pair's current `lock_version` and therefore cannot silently overwrite a rate changed by another actor.

There is no Rate Book, region, settlement book, stale-window or draft-book vocabulary in the V2 interface.

### Trade requests

The Trade requests tab reads real `exchange_trade_requests`, not generic customer intents.

It shows:

- request code;
- pair;
- customer side;
- snapshotted base and quote amounts;
- snapshotted effective rate;
- lifecycle status;
- request time.

Admin actions are constrained by the Phase 2 lifecycle RPCs:

```text
pending_admin -> approved_for_contact
pending_admin -> rejected
pending_admin -> cancelled
approved_for_contact -> completed
approved_for_contact -> cancelled
```

Approval is deliberately not equivalent to completion.

### Currencies

The dashboard reuses the existing account-scoped currency catalog. It does not create a second FX-specific currency table.

Currency reads are available to any account member. Currency mutations remain protected by Admin+ API guards and existing RLS.

### FX settings

The settings tab configures `account_exchange_settings.base_currency_id`.

This setting is a conversational/default FX counter currency only. It does not modify `accounts.default_currency`, existing pairs, rate versions or trade snapshots.

## API surface

Phase 3 adds the authenticated dashboard endpoints below:

```text
GET   /api/fx-v2/overview
PUT   /api/fx-v2/settings
POST  /api/fx-v2/pairs
POST  /api/fx-v2/pairs/:id/rates
GET   /api/fx-v2/pairs/:id/history
GET   /api/fx-v2/trades
PATCH /api/fx-v2/trades/:id
```

Read endpoints resolve the caller's account and never accept an arbitrary account id from the browser.

Mutation endpoints require Admin+ server-side. Hiding a button in the browser is not the authorization boundary.

The APIs call the deterministic V2 service/RPC layer; the browser does not insert rate versions or trade-state transitions directly.

## Read models

`src/lib/services/fx-v2/dashboard.ts` provides dashboard-specific read models for:

- currencies;
- pair + current-rate overview;
- immutable rate history;
- trade request queue.

These read models remain separate from the financial mutation RPCs so UI formatting/query needs cannot weaken transactional rules.

## UI implementation

Primary files:

```text
src/app/(dashboard)/fx/page.tsx
src/components/fx/fx-dashboard.tsx
src/components/layout/sidebar.tsx
src/components/layout/header.tsx
src/app/(dashboard)/services/page.tsx
```

The new FX surface supports Arabic, English and Korean copy according to the active locale. The finance labels are intentionally explicit about the business side:

- business buys base;
- business sells base;
- customer buys base;
- customer sells base.

This avoids the ambiguous standalone labels "buy" and "sell" that caused earlier direction confusion.

## Authorization model

- account members can read the FX dashboard and currency catalog;
- Admin+ can configure the base currency;
- Admin+ can create/reactivate pairs;
- Admin+ can publish rates;
- Admin+ can transition trade requests;
- database mutation RPCs remain service-role-only.

The route layer authorizes the human first, then calls the server-side domain service.

## Verification

Before this documentation checkpoint, the Phase 3 code passed the repository CI steps through:

- lint;
- TypeScript typecheck;
- automated tests.

The migration workflow also replayed all migrations from a clean Postgres instance and passed `supabase/ci/verify-schema.sql` including FX V2 tables/RPC assertions.

The final documentation commit triggers a fresh CI run; its status must be checked separately before the phase is called fully green on the final HEAD.

## What Phase 3 does not do

Phase 3 intentionally does not migrate AI tools. Existing `exchange_rates.*` customer/admin tools continue to use legacy contracts until Phases 4-5.

It also does not delete legacy book components/APIs/tables. They are internal compatibility surface until all runtime references have moved and Phase 7 proves zero remaining references.

## Next phase

Phase 4 migrates the customer AI/runtime path so:

- current-rate questions read the V2 pair/current-version source;
- a customer trade request creates a real `exchange_trade_request` through `createFxTradeRequest`;
- quoted rate version is carried into request creation to reject stale quotes;
- the LLM never calculates or invents the financial result itself.
