# Phase 04 Report — Anthropic-compatible & Gemini Native

## 1. Metadata

| Field | Value |
|---|---|
| Phase | 04 — Anthropic + Gemini |
| Date | 2026-09-04 |
| Branch | `main` |
| Base commit | `5f0fda0` + Phases 00–03 working tree (uncommitted) |
| Current state | uncommitted |
| Executor / Reviewer | Kilo agent / awaiting human review |
| Status | **PASS** (one human-gate on doc re-verification, §14) |

## 2. Objective and scope

- **Goal:** keep current Anthropic behavior exactly, register it properly behind the registry with official `/v1/models` pagination and live-capability handling, and add an independent Gemini **native** adapter (generate + native list + embed seam). No pgvector/embedding switch-over.
- **Implemented:** `gemini_native` protocol + adapter (`providers/gemini.ts`), Anthropic `listModels` (bounded cursor pagination), Anthropic root joining (`ctx.apiRoot`), registry + CHECK widen (migration 041), presets (`gemini`), `test-model` embeddings branch (probe-only), page-cap `bounded` reporting.
- **Deliberately NOT done:** embeddings writing/UI/gate (Phase 05); streaming/tools (ADR-010); custom Anthropic-compatible connection (scope decision below); Gemini OpenAI-compatibility shim (ADR-003).
- **Scope decision — Custom Anthropic-compatible:** NOT added this phase (no deployment approved it; ADR-007 forbids making it tenant-toggleable). The protocol slot itself exists and would accept one without adapter changes.

## 3. Outcome summary

All three protocols now run through the one registry with zero consumer brand branches: the same `generateReply` produces identical wire behavior to the legacy OpenAI/Anthropic paths (their untouched tests and this phase's regression tests pass), Gemini has an independent native adapter where capabilities come from `supportedGenerationMethods` rather than name guesses, catalog lists are capped by pages/models/bytes/time, model ids are double-prefix-safe both directions, and the API key travels only in headers. Full repo: 925 tests green, typecheck clean, lint at the pre-existing 36-warning baseline.

## 4. Official-contract verification log (required by prompt)

Checked 2026-09-04 from this build environment:

| Source | Result | Effect on this phase |
|---|---|---|
| `https://generativelanguage.googleapis.com/v1beta/models` (live GET, no auth) | **403** (endpoint exists; key required) | v1beta root + `/models` path confirmed live |
| `https://docs.anthropic.com/en/api/messages` & `/en/api/models-list` | page returns **“App unavailable in region”** (marketing wall, no schema) | field-level re-check could not happen here |
| `https://api.anthropic.com/v1/models` (live GET, no auth) | **403** (reachable, gateway-protected) | host/path existence confirmed, body schema not live-readable from sandbox |
| `https://ai.google.dev/api/generate-content` | request **timeout** ×2 | Gemini field-level schema relies on prior review |

**Contracts encoded (previously reviewed from official docs):**
- Anthropic Messages: `POST {root}messages`, `x-api-key`, `anthropic-version: 2023-06-01`, `content[]{type:'text'}`, `usage{input_tokens,output_tokens}`. — UNCHANGED legacy behavior (existing tests).
- Anthropic models: `GET {root}models?limit=&after=` → `{data[]{id,display_name,type},has_more,first_id,last_id}` (cursor).
- Gemini generate: `POST {root}models/{id}:generateContent` with `x-goog-api-key` header → `{candidates[].content.parts[].text, finishReason, promptFeedback.blockReason, usageMetadata{promptTokenCount,candidatesTokenCount,totalTokenCount}}`.
- Gemini list: `GET {root}models?pageSize=&pageToken=` → `{models[]{name:'models/…',displayName,supportedGenerationMethods[],input/outputTokenLimit},nextPageToken}`.
- Gemini embed (seam): `POST {root}models/{id}:embedContent` → `{embedding.values[]}`.

→ **Human-gate item:** field-level schema re-verification (especially Anthropic pagination param names and Gemini v1beta `systemInstruction` casing) on a machine where official docs are reachable; any mismatch is fixed with contract fixtures + an ADR per §4 of the add-provider guide. The **fixtures** in `gemini.test.ts` / `anthropic.test.ts` are the executable version of those schemas.

## 5. Decisions

| Decision | Reason | Ref |
|---|---|---|
| Anthropic fixed preset only; custom-anthropic deferred | prompt scope question; ADR-007 deployment policy | report §2 |
| Gemini auth via `x-goog-api-key` HEADER (never query) | keys must not leak into URLs/logs/redaction (§9) | prompt; verified by test `url.not.toContain(KEY)` |
| Capability classification from `supportedGenerationMethods` **only**; absent metadata → `unknown` | ADR-005: heuristics may reorder, never block or deny | gemini.ts, normalize.ts |
| Gemini id stored **bare**, `rawProviderId` keeps prefixed form; request path adds `models/` exactly once | FR-MOD-04 double-prefix | normalizeGeminiId / geminiPathSegment + tests |
| Anthropic pagination stops unless `has_more===true` AND cursor present | old gateways lack the newest fields — never assumed (docs §12.2) | anthropic list |
| Page-cap reached while more pages existed ⇒ `completeness:'bounded'` | honest catalog truthfulness | both adapters + new tests |
| Embeddings probe in `test-model`: returns `observed_dimensions` only, writes **nothing**; fixed chat-vs-embeddings fall-through bug from Phase 03 where `embeddings` wrongly called generate | Phase 05 owns vector writes; fixing route-level branch error discovered during Phase 04 | test-model route diff |
| `blocked_by_provider` distinct from `empty_response` for Gemini finishReason/promptFeedback | UI can advise “try again” vs provider refusal | gemini.ts |

## 6. Files

| File | A/M | Purpose |
|---|---|---|
| `supabase/migrations/041_ai_gemini_protocol.sql` | A | CHECK widen `+ 'gemini_native'` (additive, idempotent) |
| `src/lib/ai/providers/gemini.ts` | A | native adapter: generate/list/embed + id normalization |
| `src/lib/ai/providers/gemini.test.ts` | A | 15 tests |
| `src/lib/ai/providers/anthropic.ts` | M | `ctx.apiRoot` joining, version header preserved, `listAnthropicModels` cursor pagination, caps |
| `src/lib/ai/providers/anthropic.test.ts` | A | 8 tests incl. legacy regression + multi-page + fieldless gateway |
| `src/lib/ai/providers/normalize.ts` | M | `normalizeGeminiModels` + `normalizeAnthropicModels` (cap/stable-sort/rawId/official-metadata) |
| `src/lib/ai/providers/presets.ts` | M | `gemini` preset (+ verification note) |
| `src/lib/ai/providers/presets.test.ts` | A | 6 tests (visibility gating, gemini shape, fixed-root rejection) |
| `src/lib/ai/providers/contract.ts` | M | `gemini_native` protocol |
| `src/lib/ai/providers/registry.ts` | M | third adapter |
| `src/lib/ai/providers/registry.test.ts` | M | 3-protocol expectations |
| `src/app/api/ai/connections/[id]/test-model/route.ts` | M | embeddings probe branch (Phase-03 fall-through fix) |
| `docs/implementation/ai-multi-provider/add-openai-compatible-provider.md` | M | protocol matrix, native adapter section, id policy |

No destructive edits; user files untouched.

## 7. Data and migration

- `041_ai_gemini_protocol.sql`: replace protocol CHECK only. Nullable/absent-data safe. Forward-compatible (rows never store anything but the 3 allowed values).
- No table/column changes for catalog — envelopes already `jsonb` from 040. Rollback = revert code; constraint may remain (an unused CHECK value is harmless). Apply to staging per Phase-06 rehearsal rule.
- Gemini/Anthropic backfill nothing — legacy `ai_configs.provider` never held `gemini`, and Anthropic stays `'anthropic'`.

## 8. Security

- API keys travel only in server-defined headers (`x-api-key` / `anthropic-version` / `x-goog-api-key`); **test asserts the literal key string never appears in the request URL** (`gemini.test.ts`) and error messages carry provider detail only through the legacy `providerHttpError` path (public code only mapped to `AI_*` envelope in the two probe routes).
- Roots: only preset server values (all `fixed`); request bodies can never steer URLs.
- Pagination/size: `pageSize=100` / `limit=100` + `MAX_PAGES=5` (both protocols), body cap 2 MB streaming, `encodeURIComponent` on cursors (no injection), page tokens never echoed to clients.
- Gemini ids validated through `joinApiPath` (relative-only) + non-empty check → path traversal via model id impossible: `models/../secret` rejected before URL construction.
- Non-finite embedding values rejected before any vector literal could form (prevents pgvector garbage at seam level, ahead of Phase 05's write gate).

## 9. Tests (this phase adds 29; full-suite totals below)

| File | Coverage highlights | Result |
|---|---|---|
| `gemini.test.ts` | exact URL+header auth+no key leak+role mapping assistant→model+usage maps; raw `models/` accepted once; SAFETY & blockReason → `blocked_by_provider`; empty → `empty_response`; 403 → `invalid_key` w/o key in message; pageToken follow; methods→capabilities; custom-gateway→unknown; 5-page cap → bounded; embed order + NaN reject | 15 pass |
| `anthropic.test.ts` | legacy URL/headers/role alternation/401 regression; single page; `after=` chain; fieldless gateway safe; page cap bounded; version header on list | 8 pass |
| `presets.test.ts` | visibility gating; gemini shape; deepseek protocol; fixed rejection for gemini | 6 pass |
| registry.test.ts | 3 protocols | 3 pass |
| Pre-existing 86 files | full regression incl. OpenAI legacy path | pass |

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | clean |
| `npm run lint` | 0 | 36 warnings = baseline |
| `npx vitest run` (whole repo) | 0 | **91 files / 925 tests** |
| `npx vitest run src/lib/ai` | 0 | 151/151 |
| live network | — | only read-only probes documented §4 |

## 10. Acceptance gate

- [x] Current Anthropic unchanged: legacy generate tests (`generate.test.ts` untouched since Phase 01) + new explicit regression assertions pass; default URL/constants identical.
- [x] Gemini native adapter, no network in tests: all fetch stubbed; brand switch absent (`grep -r gemini src/app src/components` → none in consumers).
- [x] Pagination + capabilities + normalization documented + limited: §5 table, §4 verification log, bounded caps encoded + tested.
- [x] Secret never in URL or public error: `url.not.toContain(KEY)`, error-code mapping strips `.message`.

## 11. Risks and limits

| | | | |
|---|---|---|---|
| Docs unverifiable in sandbox (2 regions blocked/timed out; live endpoint existence confirmed 403-only) | med | wire-break risk on release env | human re-verify §4, then fixtures updated via one ADR if schemas differ |
| Outbound SSRF wrapper still bypassed for fixed roots | as decided Phase 03 | none while roots are code-fixed | checklist before custom enablement (unchanged debt) |
| Gemini `finishReason` enum could expand | low | generic `blocked_by_provider` | conservative: everything but STOP/MAX_TOKENS fails safe |

## 12. Rollback

Revert code files (§6) + drop 041 (or leave the wider CHECK — harmless). No data written by this phase; catalog envelopes unchanged format; test-model embeddings probe writes nothing. Legacy `ai_configs` path never depended on any Phase 04 file.

## 13. Questions and follow-ups

- Blockers: none.
- **Human:** re-verify both API schemas from an unrestricted location (Anthropic pagination param names; Gemini v1beta request casing `systemInstruction`) — update fixtures + note here.
- Follow-ups: Phase 05 (dimension gate + KB revision + settings UI) consumes adapter `embed` seams; Phase 06 routes fixed roots through `sendOutbound` as well for uniform redaction.

## 14. Transition recommendation

**GO** to Phase 05 pending only the §4/§13 schema re-verification by a human on a non-regional machine — code itself satisfies all four gates and production behavior stays on the untouched legacy path behind the dormant flag. Phase 05 not started.
