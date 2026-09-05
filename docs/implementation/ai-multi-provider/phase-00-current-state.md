# Phase 00 — Current State Report (AI Multi-Provider)

**Date:** 2026-09-03
**Branch:** `main`
**HEAD commit:** `5f0fda0907fe03b78e668b0a2c0e70ae67d506bb`
**Working tree:** clean apart from untracked `plans/` directory (this documentation set). No modified or staged files in product code.

---

## 1. Metadata

| Item | Value |
|---|---|
| Project | wacrm (private fork of ArnasDon/wacrm) |
| Branch | `main` |
| HEAD | `5f0fda0` ("Add Arbic to project") |
| Origin | `https://github.com/e-proo/wacrm.git` |
| Node engine | `>=20.0.0` |
| Package manager | npm 10.9.9 (declared via `packageManager` field) |
| Next.js | `16.2.12` |
| React | `19.2.4` |
| TypeScript | `^6` |
| Vitest | `^4.1.10` |
| ESLint | `^9` (config `eslint-config-next@16.2.12`) |
| Supabase JS | `@supabase/supabase-js@^2.107.0`, `@supabase/ssr@^0.12.0` |
| next-intl | `^4.13.5` (locales: `ar`, `en`, `ko`) |
| Repo-level instruction | `AGENTS.md` warns this is **not** the Next.js the model knows — must read `node_modules/next/dist/docs/` before framework changes |

---

## 2. Workspace status

- `git status --short` is empty; only `plans/` is untracked.
- No local edits overlapping AI code.
- No in-progress rebase, merge, or stash.
- One remote branch (`origin/main`); no other worktrees or feature branches in this checkout.
- Repo is safe to read and reason about; nothing to set aside or rescue.

---

## 3. Baseline verification (read-only)

| Command | Result |
|---|---|
| `npm run lint` | ✅ 0 errors (36 pre-existing warnings, e.g. `@typescript-eslint/no-unused-vars`, format drift) |
| `npm run typecheck` | ✅ clean (`tsc --noEmit` exited 0) |
| `npm run format:check` | ⚠️ Prettier reports style drift in 453 files — repo-wide condition, **not** introduced by AI code. Out of scope for Phase 00. |
| `npm test` | ⏸️ not executed in reconnaissance (out of scope; will run per phase gate) |
| `npm run build` | ⏸️ deferred to phase gates per roadmap |

Conclusion: the working tree compiles and lints clean. No recent change in the AI area introduces a regression.

---

## 4. Current AI call graph

### 4.1 Provider surface (lib)

```
src/lib/ai/
├── types.ts          → AiProvider = 'openai' | 'anthropic'; AiConfig; AiUsage; AiError
├── defaults.ts       → AI_PROVIDER_DEFAULT_MODEL, HANDOFF_SENTINEL, MAX_OUTPUT_TOKENS, buildSystemPrompt
├── validate.ts       → validateAiCredentials() — runs a real "ping" generation
├── config.ts         → loadAiConfig(), loadEmbeddingsKey()  — SELECT ai_configs, decrypt
├── admin-client.ts   → supabaseAdmin() service-role factory
├── generate.ts       → generateReply() — switch on config.provider → OpenAI/Anthropic
├── embeddings.ts     → embedTexts() — fixed to text-embedding-3-small, 1536 dims
├── knowledge.ts      → ingestDocument(), retrieveKnowledge() — semantic + FTS hybrid
├── chunk.ts          → text chunker
├── context.ts        → buildConversationContext()
├── query.ts          → latestUserMessage() helper
├── handoff.ts        → buildHandoffSummary()
├── usage.ts          → logAiUsage() → ai_usage_log
├── providers/
│   ├── shared.ts     → normalizeUsage(), toNetworkError(), providerHttpError(), mergeConsecutive()
│   ├── openai.ts     → POST https://api.openai.com/v1/chat/completions, Bearer auth
│   └── anthropic.ts  → POST https://api.anthropic.com/v1/messages, x-api-key + anthropic-version
└── *.test.ts         → unit tests for the above
```

**Provider dispatch is a literal `switch (config.provider)`** in `generate.ts:37-49` — exactly the pattern called out for removal.

### 4.2 API routes

| Route | File | Role gate | Purpose |
|---|---|---|---|
| `GET /api/ai/config` | `src/app/api/ai/config/route.ts` | member | Returns `provider, model, system_prompt, is_active, …, has_key, has_embeddings_key`. Strips `api_key` and `embeddings_api_key` before sending. |
| `POST /api/ai/config` | `src/app/api/ai/config/route.ts` | admin | Upsert. Validates by real generation before save (`credentialsChanged`); validates new embeddings key with `embedTexts(['ping'])`; AES-256-GCM encrypts keys. |
| `DELETE /api/ai/config` | `src/app/api/ai/config/route.ts` | admin | Delete the row. |
| `POST /api/ai/test` | `src/app/api/ai/test/route.ts` | admin | "Test key" — validates provider+model+key without saving. |
| `POST /api/ai/draft` | `src/app/api/ai/draft/route.ts` | agent | Loads config, retrieves KB, generates reply, logs usage. |
| `POST /api/ai/playground` | `src/app/api/ai/playground/route.ts` | agent | Same path as auto-reply, transcript from client. |
| `POST /api/ai/autoreply/[conversationId]` | `src/app/api/ai/autoreply/[conversationId]/route.ts` | agent | Pause/resume bot per conversation; resets reply counter. |
| `GET /api/ai/usage` | `src/app/api/ai/usage/route.ts` | admin | 1–90 day token spend summary. |
| `GET /api/ai/knowledge` | `src/app/api/ai/knowledge/route.ts` | member | List KB docs. |
| `POST /api/ai/knowledge` | `src/app/api/ai/knowledge/route.ts` | admin | Create + ingest document. |
| `POST /api/ai/knowledge/reindex` | `src/app/api/ai/knowledge/reindex/route.ts` | admin | Re-chunk + re-embed every doc for the account. |

Auto-reply itself runs **not via HTTP** but inside the WhatsApp webhook via `dispatchInboundToAiReply` (`src/lib/ai/auto-reply.ts`).

### 4.3 UI surfaces touching AI

- `src/components/settings/ai-config.tsx` — single config form (provider select, model text, key, embeddings key, system prompt, is_active, auto_reply_enabled, handoff agent, max).
- `src/components/settings/ai-knowledge.tsx` — KB document list/create/reindex.
- `src/components/agents/ai-playground.tsx` — test-chat.
- `src/components/agents/ai-usage.tsx` — spend chart, per-model breakdown.
- `src/components/inbox/ai-thread-banner.tsx` — "Take over" / "Resume AI" banner.
- `src/components/settings/ai-knowledge.tsx` — KB editor.

### 4.4 Encryption / secret lifecycle

- AES-256-GCM via `src/lib/whatsapp/encryption.ts` (`encrypt`/`decrypt`/`isLegacyFormat`). Key from `process.env.ENCRYPTION_KEY`.
- Format: `<iv-hex>:<ciphertext-hex>:<authTag-hex>`. Legacy CBC decrypt-only support (one colon) still recognized.
- Used for: `whatsapp_config.access_token`, `webhook_endpoints.secret`, `ai_configs.api_key`, `ai_configs.embeddings_api_key`.

### 4.5 Existing secrets handling (passes today)

- `GET /api/ai/config` selects `api_key` and `embeddings_api_key` only to derive `has_key` / `has_embeddings_key`, then strips both from the response.
- `ai-config.tsx` keeps a `MASKED_KEY` placeholder; never posts placeholder back as a real key.
- Decrypt failure on `embeddings_api_key` is logged and swallowed (`loadAiConfig`) so a corrupt embeddings key downgrades to lexical KB rather than breaking chat.
- Decrypt failure on `api_key` is surfaced as `key_decrypt_failed` to the draft route.

### 4.6 Embeddings path (current)

- Fixed URL: `https://api.openai.com/v1/embeddings`.
- Fixed model: `text-embedding-3-small`, **1536 dims** (`EMBEDDING_DIMENSIONS` in `embeddings.ts`).
- Hard-batched at `BATCH_SIZE = 96`.
- Stored as pgvector literal `[…]` written into `ai_knowledge_chunks.embedding vector(1536)`.
- Retrieval: `match_ai_knowledge_semantic` (cosine `<=>` against `vector(1536)`), `match_ai_knowledge_fts` (tsvector `simple` config). Semantic is best-effort and top-ups with lexical.
- No `embedding_model` / `embedding_dimensions` / `embedding_revision` columns on `ai_configs` today.

---

## 5. Database / RLS facts

Latest migration applied: **`039_inbound_media_mirror.sql`** → next migration number will be **`040_ai_provider_connections.sql`** (planned).

### 5.1 Tables relevant to AI

- `ai_configs` — created in `029_ai_reply.sql`. UNIQUE on `account_id`. Columns: `provider text CHECK in ('openai','anthropic')`, `model text`, `api_key text NOT NULL` (encrypted), `system_prompt text`, `is_active boolean`, `auto_reply_enabled boolean`, `auto_reply_max_per_conversation int (1..20)`, `created_by uuid → auth.users`, `created_at`, `updated_at`. `030` adds `embeddings_api_key text`.
- `ai_knowledge_documents` — `030`. Title + content, RLS: select any member, write admin+.
- `ai_knowledge_chunks` — `030`. `content text`, generated `fts tsvector ('simple')`, `embedding vector(1536)`, HNSW cosine index. RLS: select any member, write admin+.
- `ai_usage_log` — referred to in code (`logAiUsage`); created in `029`. SELECT admin+ only.

### 5.2 RLS helper

- `is_account_member(account_id uuid, role text DEFAULT NULL)` — already present in earlier migrations and reused by all AI policies.

### 5.3 Helper RPCs

- `match_ai_knowledge_fts(uuid, text, integer)` — `SECURITY DEFINER`, `SET search_path = public`, `STABLE`, revoked from PUBLIC, granted to `authenticated, service_role`.
- `match_ai_knowledge_semantic(uuid, text, integer)` — same hardening, casts text literal to `vector(1536)`.
- `claim_ai_reply_slot(uuid, integer)` — created in `031` for the per-conversation auto-reply cap.

### 5.4 pgvector dimension invariant

`ai_knowledge_chunks.embedding` is **`vector(1536)`**, with an HNSW cosine index (`vector_cosine_ops`). The current code path produces exactly 1536-dim vectors via `text-embedding-3-small`. Anything that writes a different length will fail the cast inside `match_ai_knowledge_semantic`.

---

## 6. Security & migration risks

| Risk | Where | Mitigation note for upcoming phases |
|---|---|---|
| Single-row `ai_configs` mixes behavior + secrets | `029` | Phase 02 needs additive split into `ai_provider_connections`; do **not** mutate the existing row shape until backfill is proven. |
| `provider` column is a brand string, not a protocol | `029` (CHECK in openai/anthropic) | Phase 01 introduces `protocol` in the **runtime layer** (TypeScript only). Phase 02 will need a migration to relax the CHECK and add `protocol` + connection FKs. |
| Embeddings key tied to chat key form factor | `030` | Phase 05 will split Chat/Embeddings selection; until then keep behavior identical. |
| `embedding` column pinned to 1536 | `030` | Hard constraint per ADR-008 — every embed path must validate length 1536 before any insert/RPC call. |
| Plain `fetch(url, …)` with hardcoded URL | `providers/openai.ts`, `providers/anthropic.ts`, `embeddings.ts` | Phase 02 introduces an Outbound Policy client; Phase 03+ dispatches through it. |
| Error messages include provider body verbatim (`providerHttpError`) | `providers/shared.ts` | Acceptable today (UI maps to a sanitized message). Phase 02 will switch to public error envelope with `request_id` only. |
| Browser never talks to providers (server-only fetch) | all current providers | Confirmed — no change needed. |
| `toNetworkError` leaks raw `err.message` | `providers/shared.ts` | Low risk today; Phase 02 should bound + redact. |
| Migration filename collision risk | next is `040_*` | Use `040_ai_provider_connections.sql`; reserve `041_…` for the embedding dimension/revision columns. |
| `format:check` baseline is red | repo-wide | Pre-existing; do not fix as part of AI work. |

---

## 7. Gap table vs. ADR/Master decisions

| # | Decision (master / ADR) | Current state | Gap |
|---|---|---|---|
| OBJ-01 | OpenAI/Anthropic regression | Both work, behavior intact | None yet — gate this in Phase 01 |
| OBJ-02 | OpenAI-compatible adapter (DeepSeek, OpenRouter, …) | Not supported; no preset list; no custom API root | Phase 03 |
| OBJ-03 | Gemini Native adapter | Not supported | Phase 04 |
| OBJ-04 | Dynamic model discovery | Not implemented; model is free text in UI | Phase 03 (discovery) + Phase 02 (catalog storage) |
| OBJ-05 | Separate Chat vs Embeddings connection | Both keys live on the same `ai_configs` row | Phase 05 |
| OBJ-06 | No secrets in client/logs/error | GET strips; logs are clean; error messages embed provider detail | Phase 02 (envelope) |
| OBJ-07 | SSRF policy + DNS rebinding protection | No custom URLs yet (safe default) | Phase 02 (add outbound policy before any custom-root path) |
| OBJ-08 | Expand/migrate/contract | Will need add-only migrations | Phases 02 & 05 |
| OBJ-09 | Add provider = preset + tests | Registry not present; switch-based | Phase 01 |
| OBJ-10 | UX with verified/stale/manual states | UX is a flat provider+model+key form | Phase 05 |
| ADR-001 | Protocol ≠ preset ≠ connection | Mixed in `ai_configs.provider` | Phase 01 (runtime split), Phase 02 (persistence split) |
| ADR-002 | `ai_provider_connections` independent entity | Doesn't exist | Phase 02 |
| ADR-003 | Gemini Native in scope | Not present | Phase 04 |
| ADR-004 | Model discovery optional/advisory | No discovery exists | Phase 03 |
| ADR-005 | Capability tri-state | Not modeled | Phase 03 |
| ADR-006 | Separate connection probe vs model probe | Test endpoint does full generation only | Phase 03 |
| ADR-007 | SSRF on deployment | No custom URLs yet | Phase 02 |
| ADR-008 | 1536 dims only | Enforced in pgvector + code today | Phase 05 must add app-layer gate before write/RPC |
| ADR-009 | Expand/migrate/contract | Not started | Phases 02 & 05 |
| ADR-010 | No streaming/tools | Confirmed out of scope | None |
| ADR-011 | JSONB bounded catalog | Not present | Phase 02 |
| ADR-012 | No retry for generation | `AbortSignal.timeout` only, no retry — confirmed | None |
| ADR-013 | Public error envelope | Today: provider body embedded in `AiError.message` (stripped for some routes, raw for others) | Phase 02 |
| ADR-014 | No free custom headers | No adapter accepts headers from client — confirmed safe | None |

---

## 8. Overlap with in-flight work

Searched `git log --all` for `provider|preset|connection|catalog|DeepSeek|Gemini|multi-provider`. No commit on any branch adds Gemini, DeepSeek, OpenRouter, or a connection entity. AI history on this checkout is bounded to:

- `b0194df` feat(ai): polish auto-reply (inbox controls, handoff, usage logging)
- `2748028` feat: AI reply assistant (bring-your-own-key)
- `020dc2a` fix(ai-kb): address code-review findings

No overlapping PRs in the local ref space; no cherry-picking needed.

---

## 9. Exact phase-by-phase file plan (read-only intent, refined from the master)

### Phase 01 — Foundation (no behavior change)

- Add `src/lib/ai/providers/registry.ts` — `ProviderProtocol` + immutable map `Protocol → ProviderAdapter`.
- Convert `src/lib/ai/providers/openai.ts` and `anthropic.ts` to satisfy `ProviderAdapter` (`protocol`, `generate`, optional `listModels`/`embed`).
- Add `src/lib/ai/providers/types.ts` — `ProviderAdapter`, `AdapterContext`, `ProviderGenerateInput`, `ProviderEmbeddingInput`, `ProviderResult`, `ModelInfo`, `ModelCatalog`, normalized errors.
- Move `normalizeUsage`/`toNetworkError`/`providerHttpError`/`mergeConsecutive` into `providers/shared.ts` (no public-API change).
- Replace `switch` in `src/lib/ai/generate.ts` with a registry lookup; keep `generateReply` signature.
- Keep `AiProvider = 'openai' | 'anthropic'` string type (re-export `ProviderProtocol` later).
- Tests: `providers/registry.test.ts`, `providers/openai.test.ts`, `providers/anthropic.test.ts` (extend existing fixtures), `generate.test.ts` (existing must pass unchanged).

**Forbidden in Phase 01:** any migration, any UI change, adding Gemini/DeepSeek, accepting custom base URLs, changing embedding behavior.

### Phase 02 — Connections + Security + additive migrations

- `supabase/migrations/040_ai_provider_connections.sql`:
  - `ai_provider_connections` table (id, account_id, name, preset_id, protocol CHECK in three values, api_root text, encrypted_api_key text, connection_fingerprint text, status CHECK, catalog jsonb, catalog_fetched_at timestamptz, catalog_error_code text, verified_at timestamptz, created_by uuid, timestamps). UNIQUE(account_id, name). RLS: SELECT any member; INSERT/UPDATE/DELETE admin+.
  - ALTER `ai_configs` ADD COLUMN `chat_connection_id uuid`, `embedding_connection_id uuid` (FK to `ai_provider_connections.id`, deferrable), `chat_model text`, `embedding_model text`, `embedding_dimensions int`, `embedding_revision text`. FKs and constraints added in a separate migration after backfill (per master §10.2).
- `src/lib/ai/connections/loader.ts` — server-only `loadRuntimeConnection(accountId, connectionId)`. Decrypts in narrow scope, returns `RuntimeConnection`, **no plaintext leaves the function**. `has_key` boolean only in DTOs.
- `src/lib/ai/connections/service.ts` — create/update/disable/delete with transactional fingerprint recompute + catalog invalidation.
- `src/lib/ai/connections/catalog.ts` — bounded JSONB shape, fetched_at TTL semantics, stale-on-error.
- `src/lib/ai/connections/presets.ts` — declarative preset list (OpenAI, DeepSeek, OpenRouter, Anthropic, Gemini, plus `custom` variants) — **without hard-coding presets that need addresses verified live**. All `defaultApiRoot` values to be cross-checked against official docs before PR; flag in ADR if a value is uncertain.
- `src/lib/ai/outbound/url-policy.ts` — canonicalize, scheme/host/port validation, DNS resolution, IP classification (use Node `net`/`dns`/`ipaddr` primitives; no hand-rolled parser). `redirect: manual`. Bound timeout/size limits.
- `src/lib/ai/outbound/transport.ts` — wrapper that routes every outbound call through the policy.
- `src/app/api/ai/connections/route.ts` — GET (member), POST (admin).
- `src/app/api/ai/connections/[id]/route.ts` — PATCH, DELETE (admin). PATCH keeps the secret when `api_key` omitted; explicit field/flag to clear. 409 on in-use delete.
- `src/app/api/ai/connections/[id]/discover-models/route.ts` — admin, rate-limited.
- `src/app/api/ai/connections/[id]/test-model/route.ts` — admin, cheap generation/embed probe.
- Feature flag (env-based): `AI_MULTI_PROVIDER_ENABLED` (default **off** until Phase 06 rollout).
- Fallback loader: when flag is off, `loadAiConfig` keeps reading the legacy `ai_configs` row.
- Tests: outbound policy unit tests with injected resolver/transport; CRUD route tests with admin/member/unauth paths; secret leakage assertions (no `api_key`, no `encrypted_api_key`, no `authorization` in any JSON path); RLS cross-account fixture tests; backfill idempotency.

### Phase 03 — OpenAI-compatible + model discovery

- `src/lib/ai/providers/openai-compatible.ts` — single adapter shared by OpenAI/DeepSeek/OpenRouter/custom-OpenAI gateways. Build paths relative to `apiRoot` (no double `/v1`). Implement `listModels` (GET `/models`); normalize → `ModelInfo[]` with stable sort, dedupe by canonical id, capped at e.g. 500, pagination-aware if provider returns it.
- Presets: `openai`, `deepseek`, `openrouter`, `custom-openai-compatible` (custom root, requires deployment flag to allow private hosts).
- Preserve legacy `OPENAI_URL` constant path until Phase 06 contract switch; both old and new flow produce the same wire output in tests.
- Cache TTL: 15 min default, `force_refresh: true` in body for explicit bypass.
- On discovery failure: keep last successful catalog, mark `stale=true`, return safe retryable error.
- Tests: contract fixtures (standard `/models`, missing `owned_by`, 404 `/models` with successful chat, oversized response, partial pages).

### Phase 04 — Anthropic + Gemini

- `src/lib/ai/providers/anthropic.ts` — port to `ProviderAdapter`. Anthropic's own `/v1/models` with cursor pagination + bounded total; capability tri-state from `capabilities` if present, else `unknown`.
- `src/lib/ai/providers/gemini-native.ts` — `models.list` (paginate with `pageToken`), strip `models/` prefix on the way in for chat endpoints, send full id back on the way out, `supportedGenerationMethods → capabilities`. Use real Gemini base URL from preset, header-based auth via `x-goog-api-key` (or query-key only where the official endpoint mandates).
- `embed` capability for Gemini: implemented in adapter but **not** wired to the KB in Phase 04 — keeps the 1536 invariant while we have no fixture confirming default dimension output. Phase 05 wires it behind the dimension gate.
- Tests: Anthropic pagination (page count + cap), Gemini native fixtures for generate/list/embed.

### Phase 05 — Embeddings + UX

- `supabase/migrations/041_ai_embeddings_dimensions.sql`:
  - Add FKs `ai_configs.chat_connection_id → ai_provider_connections(id)` and `embedding_connection_id → ai_provider_connections(id)`; add CHECK on `embedding_dimensions` (1536 only) once backfill lands.
  - Index on `(account_id, embedding_revision)` for KB lookups.
- App-layer dimension gate in `embeddings.ts`/`ingestDocument`: refuse any vector whose length ≠ 1536 **before** the RPC/insert; log `AI_EMBEDDING_DIMENSION_MISMATCH`.
- Embedding re-index state: a small `ai_knowledge_reindex_jobs` table (account_id, status, started_at, finished_at, total/processed) OR conservative single-step full reindex (drop decision to record ADR if scope is too wide for jobs). Default to the conservative option per master §8.2.
- Update `src/lib/ai/embeddings.ts` to take a `RuntimeConnection` instead of an API key string. Reuse OpenAI-compatible adapter for Chat/Anthropic-style presets that support embeddings; use Gemini native adapter where it returns 1536.
- UI: `src/components/settings/ai-connections/*` — list, create, edit, verify, test, delete; preset-aware form (fixed root is read-only, custom root revealed only for custom presets); key field shows masked state with `has_key` and explicit re-entry to overwrite.
- UI: `src/components/settings/ai-config.tsx` — replace single provider+key with two connection pickers (Chat, Embeddings), per-capability model pickers that respect tri-state capabilities and the manual-entry escape hatch.
- `messages/{en,ar,ko}.json` — add all new keys for connection management, status badges, embedding dimension mismatch, reindex progress, capability unknown. No hardcoded strings in JSX.
- Tests: dimension gate, two-connection selection in DB/API, manual model entry, stale catalog visibility, all locales render without missing keys.

### Phase 06 — Hardening + Release

- E2E flow: create connection → discover → select → test → save → draft → KB ingest → auto-reply. Cover OpenAI-compatible and Gemini native.
- Full `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` (with documented env gaps if any).
- Redaction/security review pass: assert no `api_key`/`encrypted_api_key`/`authorization` in any JSON snapshot, DOM, log fixture.
- Observability: structured log fields (`event`, `request_id`, `account_id_hash`, `connection_id`, `protocol`, `operation`, `status`, `code`, `retryable`, `latency_ms`); never log body/headers/prompts.
- Backfill idempotency fixture run; counts before/after.
- Rollback rehearsal: feature flag off, verify legacy `loadAiConfig` path still serves draft + auto-reply + KB ingest.
- Owner/date recorded for the future contract-phase migration that drops `ai_configs.{api_key,embeddings_api_key,provider}` and removes dual-write paths.

---

## 10. Blockers / questions

- **OpenAI base URL sanity check.** The snapshot says `https://api.openai.com/v1/chat/completions` and `…/v1/embeddings`. Confirmed against the current `src/lib/ai/providers/openai.ts:11` and `src/lib/ai/embeddings.ts:16`. No blocker.
- **Anthropic base URL / version.** `https://api.anthropic.com/v1/messages`, header `anthropic-version: 2023-06-01` (`anthropic.ts:11-12`). No blocker.
- **Default models in `defaults.ts`** (`gpt-5.4-mini`, `claude-haiku-4-5-20251001`) — left as free text per the existing intent; Phase 01 does not change these.
- **`next-intl` locales in repo: ar, en, ko.** No other locale files; the UI must update all three.
- **DeepSeek / OpenRouter / 9Router / Gemini endpoints** — the master marks them as "verify before locking in preset". Phase 03/04 must check official docs and record an ADR if any address is uncertain.
- **Embedding revision strategy** — master leaves the door open between "revisions" and "conservative full reindex". Recommendation: start with conservative full reindex + dimension gate; defer a job table to a follow-up.
- **Streaming / tools** — confirmed out of scope per ADR-010.

No blocker prevents starting Phase 01.

---

## 11. Recommendation

**GO.** Start Phase 01.

Rationale:

- Workspace is clean (only the new docs under `plans/` are untracked).
- `lint` and `typecheck` are green; no in-flight conflicts.
- The Phase 01 scope is a pure refactor — `AiProvider` stays `'openai'|'anthropic'`, `generateReply` keeps its signature, behavior is unchanged. No migration, no UI change, no new dependencies, no new runtime URLs.
- All follow-on phases have clear file-level targets, additive migrations with reserved numbers (`040`, `041`), and explicit non-goals.

Per the prompt's review gate, this report covers all four required items:

- Embeddings dimension constraint confirmed at **1536** (`vector(1536)` + `text-embedding-3-small` + `EMBEDDING_DIMENSIONS`).
- Base URLs policy: in Phase 01 we touch none; from Phase 03 onward every preset root is server-defined and `fixed` presets reject client override.
- Legacy data migration plan: additive migrations with feature-flagged fallback loader; no destructive change in this set of phases.
- Local changes: none to set aside.

Ready for human review and a Phase 01 prompt.