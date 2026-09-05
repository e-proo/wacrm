# Phase 03 Report — OpenAI-compatible & Model Discovery

## 1. Metadata

| Field | Value |
|---|---|
| Phase | 03 — OpenAI-compatible + model discovery |
| Date | 2026-09-04 |
| Branch | `main` |
| Base commit | `5f0fda0` + Phases 00–02 working tree (uncommitted) |
| Current state | uncommitted (no commit authorized) |
| Executor / Reviewer | Kilo agent / awaiting human review |
| Status | **PASS** (conditions in §14) |

## 2. Objective and scope

- **Goal:** make the OpenAI adapter generic (root from the server-validated connection), add a fixed DeepSeek preset, and implement optional model discovery with bounded, fingerprint-invalidated caching — while legacy generation stays untouched.
- **Implemented:** adapter root-sourcing via `joinApiPath`; `listModels` with normalization; catalog cache service + `discover-models` and `test-model` routes; verification revocation on credential patch; in-flight coalescing.
- **Deliberately NOT done:** Gemini/Anthropic pagination (Phase 04); embeddings via connections (Phase 05); any production read switch; new dependencies; UI.
- **Deviation (documented):** DeepSeek root could not be live-verified — `api-docs.deepseek.com` is unreachable from this environment (2 transport failures logged). The preset uses the officially documented `https://api.deepseek.com/` base; connectivity to `api.deepseek.com:443` was verified (DNS resolves via CloudFront, TCP 443 open). **Human re-check of the docs is a release gate (§14).**

## 3. Outcome summary

Compatible providers are now presets, not code. The registry returns the same `openai` adapter for any OpenAI-shape connection; chat URLs and model lists join relative paths onto the stored root without duplication, discovery failure is safe (404 ⇒ `AI_MODEL_DISCOVERY_UNSUPPORTED`, cached catalog and manual entry survive), and the catalog cache cannot serve the wrong account/key because every envelope embeds the connection fingerprint. The legacy path is byte-identical (all 21 pre-existing AI behavior tests unchanged and green). 900 tests, typecheck and lint clean at baseline.

## 4. Decisions

| Decision | Reason | Ref |
|---|---|---|
| `ctx.apiRoot` optional; adapters fall back to the preset default | Legacy `ai_configs` requests must keep hitting identical URLs until Phase 05 switch-over | ADR-009 dual-read |
| `joinApiPath` with `/v1/v1` collapse + traversal rejection | Master §9.4 requires roots incl. version segment; clients can never shape paths anyway (roots come from server presets/validated custom) | §9.4 |
| Envelope embeds `fingerprint` + `CATALOG_SCHEMA_VERSION` | Rotation ⇒ stale without column changes; version bump invalidates all caches without migration | docs §12.4, ADR-011 |
| 404/405 = capability absence, not connection failure | ADR-004/006 split of discovery vs generation proof | gate #2, #8 |
| In-flight coalescing per connection | docs §7 concurrency gate; one admin can't fan out provider billable calls by double-clicking | §7 |
| `AI_CONFIG_CONFLICT` when fingerprint changes mid-request | Discards a catalog fetched under stale credentials; §6 step 8 | docs §6 |
| DeepSeek `defaultApiRoot` = `https://api.deepseek.com/` | Official docs state that base (no `/v1`); version-less joining exercised in tests | §3 below |
| test-model never retries; probe text fixed, tiny, customer-free | Cost safety; ADR-012; docs §11 | |

## 5. Files

| File | A/M | Purpose |
|---|---|---|
| `src/lib/ai/outbound/url-join.ts` | A | `ensureTrailingSlash` + `joinApiPath` (the root matrix) |
| `src/lib/ai/outbound/url-join.test.ts` | A | 7 tests over trailing-slash/version/prefix/traversal roots |
| `src/lib/ai/outbound/bounded-json.ts` | A | stream-capped JSON reader (closes Phase-02 debt #2) |
| `src/lib/ai/providers/normalize.ts` | A | OpenAI `/models` → `ModelInfo`, dedupe/sort/caps, envelope pack/unpack/freshness (moved here to break loader↔catalog cycle) |
| `src/lib/ai/providers/normalize.test.ts` | A | 12 normalization + freshness tests |
| `src/lib/ai/providers/openai.ts` | M | root from `ctx.apiRoot` (default = legacy URL), `listOpenAiCompatibleModels`, error mapping |
| `src/lib/ai/providers/openai.test.ts` | A | 9 adapter tests (root sourcing, 404-discovery, 401, non-JSON, oversize, empty list) |
| `src/lib/ai/providers/contract.ts` | M | `apiRoot?` + `CATALOG_SCHEMA_VERSION` |
| `src/lib/ai/providers/presets.ts` | M | `deepseek` preset (documented base; env-gated custom unchanged) |
| `src/lib/ai/connections/catalog.ts` | A | cache/refresh service: fresh-serve w/o provider call, coalescing, stale-on-error, fingerprint guard |
| `src/lib/ai/connections/catalog.test.ts` | A | 6 service tests incl. mid-flight rotation |
| `src/lib/ai/connections/loader.ts` | M | honest `catalogStale` derivation (fingerprint-aware); server-only boundary follows the repo's convention in place of the uninstalled `server-only` package (Phase-02 latent bug — tests could not import the loader before this) |
| `src/app/api/ai/connections/route.ts` | M | GET simplification (loader owns DTO) |
| `src/app/api/ai/connections/[id]/discover-models/route.ts` | A | explicit discovery (admin, rate-limited, no URL/key in body) |
| `src/app/api/ai/connections/[id]/test-model/route.ts` | A | explicit per-model generation probe; embeddings probe honestly 4xx'd until Phase 05 |
| `docs/implementation/ai-multi-provider/add-openai-compatible-provider.md` | A | compatibility-subset + preset guide |
| `supabase/migrations/*` | — | **no migration needed in Phase 03** |
| `src/lib/ai/connections/service.ts` | M | PATCH revokes `status/verified_at` on key/root change; fingerprint uses effective root when only the key rotated (bug guard) |

No prior user files were overwritten; Phase 00/01/02 deliverables intact except the listed edits.

## 6. Flow before/after

Before: discovery absent; chat URL hardcoded; PATCH key change left `status='verified'` intact (stale proof).
After: explicit `POST …/discover-models` → (fresh cache ? no network : decrypt → adapter.listModels via policy-validated stored root → fingerprint-check → save envelope) and `POST …/test-model` → single tiny generation. Legacy draft/auto-reply/playground path: unchanged (`ctx.apiRoot` unset ⇒ same URL).

## 7. Data and migration

N/A for schema — Phase 03 stores only inside existing 040 `catalog`/`catalog_fetched_at`/`catalog_error_code` columns. No legacy column reads/writes added. Rollback = revert code (data written is self-describing in the catalog columns and harmless if unused).

## 8. Security and privacy

- Roots only come from presets (fixed) or Phase-02 outbound policy (custom, off by default). Client request bodies carry **no** URLs or keys — routes accept only `{force_refresh}` / `{capability, model}`.
- `loadRuntimeConnection` decrypts server-side; `RuntimeConnection` never serialized; DTOs contain neither ciphertext, plaintext, nor fingerprint (catalog envelope stored inside rows is never echoed — routes return parsed `models/fetchedAt`, not raw envelope fields).
- Responses use safe code (`AI_*` envelope in the two new routes) and fixed public messages; provider error detail flows through the existing `providerHttpError` redaction path only into error codes, not bodies (the AiError message text on legacy 4xx is already surfaced by pre-Phase-02 routes and Phase 06 review is scheduled to replace it wholesale).
- Size limits enforced **during** body streaming (`readBoundedJson`, 2 MB default), replacing the Phase-02 constant-only stub. Content-length pre-check too. Timeouts via `AbortSignal`; discovery and test are separately rate-limited; generation probe has **zero** retries.
- Remaining accepted gap (truthful): `sendOutbound` is not yet routed through `fetch` inside the adapters for the preset roots (fixed HTTPS presets ⇒ Phase-02 SSRF surface is unchanged from Phase 01: static code-controlled URLs). The policy wrapper is required at the first custom-root enablement — Phase 05/06 checklist item, and `test-model`/discovery refuse non-validated roots by nature of loading them from DB.
- Embedding probe honestly returns `AI_UNSUPPORTED_CAPABILITY` until Phase 05 (no false success).

## 9. Tests

| Test file | Scenarios | Result |
|---|---|---|
| `url-join.test.ts` | trailing slash ±, `/v1/v1` collapse, version-less root, gateway prefix, URL object, absolute/`..`/empty rejects | 7 pass |
| `normalize.test.ts` | standard payload, unknown-not-unsupported, case-sensitive dedupe, stable sort, 500-cap ⇒ `bounded`, field drops, envelope round-trip, TTL expiry, fingerprint rotation | 12 pass |
| `openai.test.ts` | default root = legacy URL, **DeepSeek-style same-path flow**, GET join URL+auth header, 404→unsupported, 401→invalid_key, non-JSON→malformed, declared-size→malformed, empty list OK | 9 pass |
| `catalog.test.ts` | fresh cache w/ **zero** provider calls, persist+clear-error, stale-on-failure keeps catalog and does **not** touch catalog column, mid-flight fingerprint rotation ⇒ conflict + no write, concurrent coalescing⇒1 call, force bypasses cache | 6 pass |
| `service.test.ts` + additions | key-only patch fingerprints under **existing** root, rotation revokes verified, no-op root keeps verification, name-only no touch | 13 pass |
| pre-existing 84 files / all AI suites | regression incl. OpenAI/Anthropic `generate.test.ts` unchanged expectations | pass |

### Command results

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | clean |
| `npm run lint` | 0 | 0 errors / 36 warnings = Phase-00 baseline |
| `npx vitest run src/lib/ai` | 0 | 126/126 |
| `npx vitest run` (full) | 0 | 900/900 |
| `npx tsc --noEmit` (via typecheck) | 0 | clean |

## 10. Acceptance criteria

- [x] **Gate 1** — adding a compatible provider needs no generate-logic change: the DeepSeek flow in tests and `add-openai-compatible-provider.md` §2 prove preset+fixture only. Registry resolution test from Phase 01 still green.
- [x] **Gate 2** — `/models` optional and manual path tested: empty/404/unsupported each keep manual entry; no branch keys off a brand name.
- [x] **Gate 3** — cache/stale/invalidation correct: TTL + fingerprint + schema-version freshness; failure keeps last good list flagged stale; rotation invalidates display (catalog.test.ts, normalize.test.ts).
- [x] **Gate 4** — legacy OpenAI unbroken: zero modified assertions in `generate.test.ts`; default URL asserted unchanged.

## 11. Risks and limits

| Risk/limit | Prob | Impact | Mitigation |
|---|---|---|---|
| DeepSeek base URL live drift (docs unreachable from sandbox) | low | med (fixed preset) | Re-verify + one-test fixture before release; flagged for human gate §14 |
| Discovery route can be spammed within the bucket spending provider quota | med | low | Separate `aiDraft` bucket + coalescing cap + manual-trigger-only UI path |
| `unknown` capability spamming UI with hundreds of dead models (e.g. llama farm on OpenRouter) | med | UX | completeness flag + sort; Phase 05 UX can surface badges, no block added per ADR-005 |
| Catalog envelope stored in jsonb grows to cap | low | low | 500 model cap + field lengths enforced pre-store on write AND re-checked on read |
| sendOutbound policy not yet in adapter hot path | med | — | acceptable while roots are code-defined; mandatory before any custom-root enablement (Phase 05/06 checklist) |

## 12. Rollback

Revert the 15 files listed in §5 (additive modules + small edits). No data touched, no migration, flag still gates everything; the discovery/test routes 404 with flag off. Legacy behavior independent.

## 13. Questions and follow-ups

- Blockers: none.
- **Human required:** re-check `api-docs.deepseek.com` for the base-URL wording on the release machine; confirm OpenRouter inclusion decision (out of my authorized scope unless the owner says so; presets.ts extensible per guide §2).
- Follow-ups: route `sendOutbound` through adapters when `AI_CUSTOM_ENDPOINTS_ENABLED` first ships (filed above); Phase 04: Anthropic/Gemini adapters + pagination; Phase 05: embeddings gate + UI.
- Debt without owner: none new (bounded-json closed Phase-02 debt #2; the loader/server-only fix closed the latent testability issue).

## 14. Transition recommendation

**GO** to Phase 04 upon: (1) human re-verification of the DeepSeek base URL from official docs (site blocked from this environment — the only unverified assumption here), and (2) acceptance of §8's honest note that the SSRF policy wrapper applies from first custom-root enablement, since all Phase 03 roots remain server-defined fixed values. Until then production behavior is unchanged: the flag keeps these routes dormant and `generateReply` untouched.
