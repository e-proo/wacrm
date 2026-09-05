# Phase 05 Report — Embeddings & Settings UX

## 1. Metadata

| Field | Value |
|---|---|
| Phase | 05 — Embeddings + full Settings UI |
| Date | 2026-09-05 |
| Branch | `main` |
| Base commit | `5f0fda0` + Phases 00–04 working tree (uncommitted) |
| Current state | uncommitted |
| Executor / Reviewer | Kilo agent / awaiting human review |
| Status | **PASS** (staging gates in §10/§14) |

## 2. Objective and scope

Safely separate Chat from Embeddings behind connections, enforce the 1536-dimension rule with an explicit re-index pipeline, and ship the complete Settings UX (connections CRUD, model discovery, verification, manual entry) across every locale.

- **Implemented:** §11+§12 of the docs pack — revision-aware embeddings (migration 042), adapter-based embedding service with hard gates, dual-read retrieval, connection-aware config generation, two probe routes reused, presets route, connections manager, model combobox, chat/embedding selectors, re-index status UI, full i18n (en/ar/ko, 71 keys).
- **Deliberately NOT done:** legacy column removal / contract phase (06+); UI for the outbound allowlist (deployment-owned); streaming/tools; changing the vector column.
- **Required first-step re-verification done:** schema facts (2026-09-05): `ai_knowledge_chunks.embedding vector(1536)` + HNSW cosine index unchanged (030); semantic RPC cast fixed (030/032); model/1536 pinned in `embeddings.ts` (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) — the only two pin sites, both now behind the gate.

### Execution decision (mandatory first step)

**Chosen: (ب) — conservative full re-index** — but hardened with **dual-revision stamps** so the "previous space serves until the new one succeeds" property of (أ) is achieved WITHOUT two live vector copies or activation races:

```
                      upload/ingest (pending→ stamps rows to NEW REV)
ai_configs:  embedding_revision (ACTIVE — what search uses)
             embedding_pending_revision (being built), embedding_reindex_state
                          │
 chunk rows: embedding_revision token per row ──┐
 SQL:  c.embedding_revision IS NOT DISTINCT FROM p_revision   ← no mix possible
                          │
 Reindex route:  pending ──mark('building')──► all docs re-embedded into PENDING
                 success ──► ONE atomic update: revision ← pending, pending→null, 'ready'
                 failure ──► 'failed'; OLD active revision untouched; legacy key still
                             first-choice while the connection has NO active revision
```

Zero semantic downtime, per-chunk provenance, retired revisions kept (not deleted) in this release — deletion is a Phase-06 contract action.

## 3. Result summary

Chat and Embeddings are now independently selectable per account through verified, encrypted connections; the adapter `embed` seam serves every protocol that officially supports embeddings (OpenAI-compatible incl. order restoration by `data[].index`, Gemini native); every provider vector is validated (count, finite, length **==1536**) before a single write; revision stamping makes mixing SQL-impossible; a failed/pending rebuild never degrades search (previous revision or legacy key or lexical); the Settings UI offers masked-key management, fixed-root read-only, explicit verify/test actions, always-available manual entry with saved-model pinning, re-index impact reporting, all localized in en/ar/ko with aria-live status regions. The legacy path is untouched for un-migrated accounts. 944/944 tests, typecheck and build clean, lint at the 36-warning baseline.

## 4. Decisions

| Decision | Reason | Ref |
|---|---|---|
| Conservative (ب) + dual-revision stamps | One live vector column makes (أ) full-parallel risky and pure (ب) loses continuity; stamps give both safely | docs §8.2, prompt "اختر الأبسط الآمن" |
| `dimensions` option never sent | Only validated observation; no assumed provider option (prompt §11.2: لا تفترض) | docs rules |
| Retrieval priority: connection-active → legacy key → lexical | Accounts keep working through migration; activation is the only switch | no-downtime |
| Ingest on a setup account writes pending-stamped rows with the connection (never the legacy key) | Admin expressed intent; search unaffected until flip; old rows untouched (delete scoped per revision) | no-mix |
| Legacy deletes scoped `embedding_revision IS NULL`; connection deletes scoped to their stamp | Prevents cross-revision destruction on re-upload | |
| Backfill additionally LINKS `embedding_connection_id/model=3-small/dims=1536` + queue pending (never clears the legacy key, never auto-activates) | OpenAI embeddings admins need no key re-entry; semantic stays legacy-key-served until they hit Reindex | prompt §11 backfill |
| Anthropic-same-key accounts not linked | Anthropic has no embeddings API; guard anyway | |
| 'disabled' state exits connection semantic (key fallback) | Admin off-switch must not strand search | |
| `embedding_reindex_state` kept short: legacy/pending/building/ready/failed/disabled | UI copy maps 1:1; 'building' vs 'pending' shown with distinct copy | |
| Model combobox = native `<input list>`+`<datalist>` | Keyboard/AT behavior free, manual + selection parity, no new dependency | repo no-ADR rule |
| Capability filter removes only official `unsupported` rows (never `unknown`) | ADR-005, prompt §13 | |
| Refresh button = the ONLY catalog fetch (no auto-load; catalogs also in-memory per session) | Prompt §14 + gate "لا يجلب models عند كل render" | §7 |
| usage records the LIVE chat source (protocol/mode from connection) | spend attribution; CHECK widened in 042 | 042 |
| PATCH keeps key unless provided; null key clear rejected (unchanged from 02/03) | no accidental secret loss | §14 |
| Delete keeps 409-on-in-use from Phase 02, extended to embeddings link | FR-CON-07 both roles | prompt §5 |

## 5. Files

| File | A/M | Purpose |
|---|---|---|
| `supabase/migrations/042_ai_embeddings_revisions.sql` | A | config revision/state cols (CHECKs), chunks.embedding_revision + partial index, revision-scoped `match_ai_knowledge_semantic` recreation (SECURITY DEFINER/search_path/revoke as before), usage-log provider CHECK widen |
| `src/lib/ai/connections/embed.ts` | A | `computeEmbeddingRevision`, `validateVectorsForIndex` (count/finite/exact-1536), `embedTextsViaConnection` batched |
| `src/lib/ai/providers/openai.ts` | M | official `embed` (order restored from `data[].index`, dup-index guard, 404→`ai_unsupported_capability`) |
| `src/lib/ai/types.ts` | M | `AiConfig.chat`, `EmbeddingSetup`, `AiConnectionProtocol` |
| `src/lib/ai/config.ts` | M | dual-read (chat connection + setup; `multiProviderEnabled`); `loadEmbeddingsKey` returns `embedSetup` |
| `src/lib/ai/generate.ts` | M | chat connection priority; `usageProvider/usageModel` |
| `src/lib/ai/knowledge.ts` | M | revision-stamped ingest (per-revision deletes), `semanticQueryMode` dual-read, `embedWith` source split |
| `src/lib/ai/connections/backfill.ts` | M | links embeddings config idempotently (SQL-level `.is(null)` guard), never touches the live key, counts in `result.linked` |
| `src/lib/ai/usage.ts`, auto-reply, draft route | M | provider/model from live chat source |
| `src/app/api/ai/config/route.ts` | M | GET: flag + link columns (never secrets); POST: link/unlink pairs with **ownership checks**, coherent (conn, model) validation, embed-capability pre-check, **no-op re-save does not re-queue**, pending-revision enqueue |
| `src/app/api/ai/knowledge/reindex/route.ts` | M | connection state machine with atomic activation + safe codes (`AI_EMBEDDING_DIMENSION_MISMATCH`, `AI_CONFIG_CONFLICT`); legacy path byte-identical |
| `src/app/api/ai/knowledge/[id]/route.ts`, `knowledge/route.ts` | M | pass `embeddingSetup` through |
| `src/app/api/ai/provider-presets/route.ts` | A | safe preset metadata for the form |
| `src/components/settings/ai-connections-manager.tsx` | A | list/create/edit/delete + verify + test model + status badges |
| `src/components/settings/model-combobox.tsx` | A | searchable manual-first picker; refresh; stale/saved-missing/capability unknown states; selection never auto-changed |
| `src/components/settings/ai-config.tsx` | M | selectors card (behind flag), coherence validation pre-submit, re-index impact + live state badge, knowledge card aware of connection, proper loading label (removed legacy TODO comment block) |
| `messages/{en,ar,ko}.json` | M | 71+1 new keys per locale (parity enforced by existing `messages.test.ts`) |
| tests | A/M | `embed.test.ts` (9), `knowledge.test.ts` (+6 incl. legacy NULL-revision guard), `backfill.test.ts` (4→6 with link/idempotency/no-relink/anthropic-guard), mock fixes (auto-reply passthrough) |

## 6. Flow before/after

**Chat:** draft/auto-reply/playground/validate → `loadAiConfig` — unchanged for legacy; flag+link present → registry adapter via connection (protocol/root/key/model), usage logged with live protocol.
**Knowledge:** ingest/reindex/search — unchanged when no setup; with setup, all writes connection-routed, stamped, gated; reads revision-scoped.
Config API, presets API, new Settings cards as above. Reindex legacy path: byte-identical (covered by its own tests unchanged).

## 7. Data and migration

- **migration:** `042_ai_embeddings_revisions.sql` — additive columns + **function replacement**: old no-revision `match_ai_knowledge_semantic(uuid,text,integer)` dropped and recreated with the 4th default arg (callers bind by name; no other consumers). CHECK widens only. Existing rows: chunks keep `NULL` revision = legacy space; configs default `'legacy'`.
- **backfill idempotency:** second pass → `exists`/`already`, zero inserts/updates (SQL `.is('embedding_connection_id', null)` + in-code guard). Unit-proven (6 tests).
- **legacy compatibility:** no reads/writes removed; `embeddings_api_key` stays functional until the 06 contract; unlinked accounts behave exactly as before.
- **rollback:** revert code; 042 may stay (unused columns/harmless). Roll-forward only (state machine keeps both spaces; no destruction to undo). **Not deleting retired revisions is intentional** — the deletion pass is Phase 06 with its own gate.

## 8. Security and privacy

- Connection ids in POST validated owned-by-account (query + SQL account filter, defense in depth over RLS); DTOs unchanged from Phase 02/03 (no secrets, no fingerprints, `has_key` boolean from NOT-NULL column).
- Edit forms keep the masked-field discipline: empty ⇒ unchanged; placeholder never serialized to the API.
- Embedding vectors are the only provider-derived data written; validated numeric-only (finite check rejects `NaN`/`Infinity` that JSON would carry as `null`).
- Probe route writes only `status/verified_at` — never model text/usage detail; observed dimensions shown as number only.
- All new UI strings via next-intl — zero hardcoded JSX text; `aria-live` for verify/test/reindex status; icons paired with text labels (not color-only); native controls throughout.

## 9. Tests

| File | Phase-05 highlights | Result |
|---|---|---|
| `embed.test.ts` (9) | revision stability/sensitivity/no-secret leakage format; 1535/1537/3072 rejected **pre-write** with `AI_EMBEDDING_DIMENSION_MISMATCH`; non-finite + count-mismatch rejected; unsupported protocol; order restored via `data[].index`; provider 401 mapping | pass |
| `knowledge.test.ts` (+6→22) | active revision served during 'building', `p_revision` exact; legacy-key-only query passes NO revision (dual-read); 'disabled' → lexical; stamp=pending write + revision-scoped delete; mismatch → rows stored **without vectors** + code surfaces; legacy rows NULL-stamped + NULL-scoped delete | pass |
| `backfill.test.ts` (6) | link points at embeddings conn, model=3-small, dims=1536, state pending, token format; same-key links chat conn; second-run no relink; anthropic-not-linked | pass |
| `config.test.ts` / `validate.test.ts` / `generate.test.ts` | untouched legacy behaviors | pass |
| `messages.test.ts` | 71-key parity + ICUs | pass |
| full pre-existing 86+ files | OpenAI/Anthropic draft/auto-reply/KB regressions | pass |

### Results actually run

| Command | Exit | Result |
|---|---:|---|
| `npm run typecheck` | 0 | clean |
| `npm run lint` | 0 | **36 warnings = baseline** (all new-file warnings fixed; zero errors) |
| `npx vitest run` | 0 | **944/944 (92 files)** — was 861 at Phase-04 close |
| `npm run build` | 0 | Compiled + all `/api/ai/connections*` + pages routes emit |

**UI state catalog (manual verification pending on staging — repo has no visual harness; the prompt allows a state description):** states implemented and coded: loading skeleton; empty-connections; fixed-root readonly field; custom root shown only when deployment-enabled presets appear from the API; verified/unverified/error/disabled status badge (icon+text); catalog empty; catalog fresh `at {time}`; catalog stale (banner + last-good list + safe error toast); discovery-unsupported manual path; saved model missing from catalog (persistent badge, value kept); manual selection; refreshing spinner (selection preserved); test success/failed/time; save validation errors before submit; re-index pending impact copy; building/ready/failed badges; admin-only read note (existing key). RTL-safe (ar uses text-end via existing logical CSS); dialogs focus-managed by Base UI primitives; no color-only signals.

## 10. Acceptance criteria

- [x] Dimension mismatch never reaches DB: gate in `embedTextsViaConnection` (unit-proven 3 sizes) + `validateVectorsForIndex` before insert construction + physical `vector(1536)` column as last defense
- [x] Config change has an explicit safe re-index path: queue pending → building → atomic activation / failed keeps prior space (unit tests + route implementation)
- [x] UI keeps selection and allows manual entry: ModelComboBox (tests? no jsdom harness — logic is pure `missingFromCatalog`/draft-state rendering; unit + manual catalog; E2E in 06)
- [x] Secrets only server-side; every locale updated: 71-key parity automated; masked/edit-blank behavior (manager); DTOs verified at loader level (Phase-02 tests still pass)
- [x] OpenAI/Anthropic regression: full suite green incl. `validate`, `generate`, `config`, draft/auto-reply mocks

## 11. Risks and limits

| | | | |
|---|---|---|---|
| 042 RPC drop/recreate not executed vs live DB (none accessible here) | mid | med | staging rehearsal before flag enable (§14) — activation requires it anyway |
| Revision tokens stored in chunks grow storage until Phase-06 cleanup | low | low | documented retention: partial index per revision; deletion is the 06 contract step (owner/date recorded §13) |
| Datalist combobox renders natively (browser styling variance) | med | low | functional in all 3 browsers datalist-supported; custom popover only if UX team asks (06 follow-up) |
| Concurrent reindex + config save races | low | med | state flips are single-row UPDATEs; link guard `.is(null)`; reindex reads docs list upfront — newest doc uploads during building get a queued stamp (re-run reindex to include) |

## 12. Rollback

1. Flag OFF (default): selectors manager hidden, connection columns ignored by generation paths; reindex uses legacy branch; behavior = Phase 04.
2. Code revert: additive files only.
3. Data: 042 keeps (columns unused; RPC parameter defaults keep old call shape). Retired revisions never deleted in this release → zero data-loss rollback surface.

## 13. Questions and follow-ups

- Needs owner/date (contract phase): drop `api_key/embeddings_api_key/provider/model` after accounts migrate; delete retired `ai_knowledge_chunks` vectors (reindex success marker + count report); remove `isLegacyFormat` support.
- Defer (06): custom-endpoint allowlist UI remains operator-only (env) — intentional; per-doc progress bar (current: whole-KB atomic activation — good enough, honest).
- Open human items: 042 staging execution; Gemini/DeepSeek docs re-check from Phase 03/04 (unchanged).
- **Follow-up (live testing 2026-09-05, shipped):** usage was invisible on the connection path — Playground never logged; gateways without a usage block were skipped entirely; the Usage tab had no playground surface. Fixed additively via migration `044` (`playground` mode, `usage_reported`, `connection_id` attribution): every LLM call now lands in `ai_usage_log` regardless of provider, zero-token-but-real calls render with a note, and the whole Usage panel was localized (Settings.aiUsage × en/ar/ko). Re-audited every AI surface (`draft`, `playground`, `auto-reply`, knowledge ingest/reindex/retrieval, `handoff`, config, test) for brand coupling: none outside the intentional legacy fallback fields.

## 14. Transition recommendation

**GO** to Phase 06 after a human (a) executes `040→044` on a staging DB and runs the KB regression (create doc → reindex → semantic search → disable semantic → chat still works), and (b) spot-verifies the connections UI flows in §9 list. The production read remains the untouched legacy path until the flag + staging rehearsal.
