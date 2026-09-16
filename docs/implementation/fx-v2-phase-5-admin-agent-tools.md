# FX V2 Phase 5 — admin agent tools and approvals

Status: implemented on `test/ai-runtime-kb-tools-v2`, verified by repository CI, and migration `082_fx_v2_admin_agent_tools` applied/verified on TEST/STAGING only.

## Goal

Phase 5 removes the legacy Rate Book model from the model-exposed administrative FX tool surface while preserving the existing trusted-admin and human-approval boundary.

The administrative flow is now:

```text
verified admin agent
  -> pair/trade read tool
  -> typed proposal tool
  -> Change Request
  -> human approval
  -> deterministic FX V2 service/RPC
  -> immutable/audited domain state
```

The model never receives an authoritative FX write tool.

## Pair-centric admin reads

Tool: `exchange_rates.admin_list_pairs@1`

Implementation: `src/lib/ai/tools/fx-v2-admin-tools.ts`

The tool returns explicit FX V2 pairs with:

- `pair_id`;
- base and quote currency codes;
- pair status;
- optimistic `lock_version`;
- current immutable `rate_version_id` and version number when published;
- current `business_buy_rate` and `business_sell_rate`;
- source and publication timestamp.

It replaces the model-exposed `exchange_rates.admin_list_books` contract. The legacy executor/table code is intentionally left for Phase 7 cleanup, but it is no longer registered as a current platform tool.

## Rate-change proposal

Tool: `exchange_rates.propose_pair_change@2`

The version was bumped because the contract is no longer book-centric. The proposal now requires:

- `pair_id`;
- exact `expected_lock_version` from the preceding pair read;
- positive `business_buy_rate`;
- positive `business_sell_rate`;
- optional internal note.

Before creating a Change Request, the executor verifies that the pair still exists, remains active, and still has the expected lock version.

The created Change Request targets `fx_rate_pair/update`. After human approval, `executeApprovedChangeRequest` calls `publishFxRateVersion`, which calls the Phase 2 `publish_exchange_rate_pair_version_v2` RPC using:

- the approved pair id;
- the approved expected lock version;
- the approved buy/sell rates;
- `source = admin_agent`;
- the Change Request id as `source_change_request_id`.

Therefore a stale proposal is rejected again transactionally even after approval; it cannot overwrite a newer rate.

## Trade-request administration

Read tool: `exchange_rates.admin_list_trade_requests@1`

Proposal tool: `exchange_rates.propose_trade_decision@1`

The read tool exposes the FX V2 request snapshot required for operational review:

- request id/code;
- pair and customer side;
- amount basis/requested amount;
- immutable rate version;
- effective rate;
- snapshotted base/quote amounts;
- lifecycle status;
- bound contact/conversation ids;
- creation time.

The decision proposal supports only `approve` or `reject`, and only for a request currently in `pending_admin`.

The Change Request targets `fx_trade_request/update` and stores `expected_status = pending_admin`. After human approval, the deterministic executor calls `decideFxTradeRequest` / `decide_exchange_trade_request_v2` with the Change Request id attached.

An approval transitions the request to `approved_for_contact`. It does **not** mark the financial trade as settled or completed. Completion remains a separate authoritative business action.

## Authorization boundary

All four Phase 5 tools are admin-plane only.

The platform registry keeps the existing capabilities:

- pair/trade reads require `rates.read`;
- rate/decision proposals require `rates.propose`.

Proposal tools remain `propose` permissions and require the existing trusted-admin identity plus Change Request approval flow. No model-exposed tool is granted an authoritative `execute` permission.

The runtime sanitizes Change Request confirmation secrets before tool results enter model context.

## Grant migration

Migration: `supabase/migrations/082_fx_v2_admin_agent_tools.sql`

Migration 082 preserves the authority of already-published admin revisions without widening access to unrelated revisions:

- existing `exchange_rates.admin_list_books@1 read` grants are renamed to `exchange_rates.admin_list_pairs@1 read`;
- existing `exchange_rates.propose_pair_change@1 propose` grants are upgraded to v2;
- only revisions that already had the pair read grant receive `exchange_rates.admin_list_trade_requests@1 read`;
- only revisions that already had the rate proposal grant receive `exchange_rates.propose_trade_decision@1 propose`.

TEST/STAGING verification after applying migration 082:

```text
exchange_rates.admin_list_pairs          @1 read     11 grants
exchange_rates.admin_list_trade_requests @1 read     11 grants
exchange_rates.propose_pair_change       @2 propose  11 grants
exchange_rates.propose_trade_decision    @1 propose  11 grants
```

No `exchange_rates.admin_list_books@1` grants remain on the TEST project.

## Tests and CI

Coverage added/updated for Phase 5 includes:

- exact current platform tool registry and versions;
- removal of `admin_list_books` from the registered tool surface;
- admin/customer plane inheritance and policy checks;
- `rates.propose` requirement for FX rate proposals;
- pair read DTOs and optimistic lock behavior;
- rate proposal Change Request payloads;
- pending trade-request reads;
- trade-decision Change Request payloads;
- approved Change Request execution through `publishFxRateVersion` and `decideFxTradeRequest`;
- stale/conflicting deterministic service errors propagating as execution conflicts.

Before migration 082 was applied to TEST/STAGING, the branch CI passed lint, typecheck, tests and build, and the migrations workflow replayed every migration through 082 on a clean local Supabase database successfully.

After the TEST/STAGING apply, migration history and grant counts were queried directly and matched the expected state above.

## Security review note

Migration 082 only remaps/inserts frozen tool-grant rows and updates a table comment; it introduces no new table, RPC, SECURITY DEFINER function, or public Data API surface.

A post-apply Supabase Security Advisor run still reports pre-existing project-wide findings (including legacy SECURITY DEFINER execute grants/search-path findings). Those findings are outside the Phase 5 FX grant migration and are not treated as newly introduced by 082.

## Phase 5 completion boundary

Phase 5 is complete when the administrative AI surface is pair-centric, proposals remain human-approved, TEST/STAGING grants are migrated, and CI passes. Legacy Rate Book tables/RPCs/dead runtime code are intentionally **not deleted here**; destructive cleanup remains Phase 7 after all prior phases and E2E messaging acceptance are complete.
