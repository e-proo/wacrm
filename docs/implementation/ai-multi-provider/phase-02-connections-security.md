# Phase 02 Report — Connections + Security + Additive Migration

## 1. Metadata

| Field | Value |
|---|---|
| Phase | 02 — Connections and security |
| Date | 2026-09-04 |
| Branch | `main` |
| Base commit | `5f0fda0907fe03b78e668b0a2c0e70ae67d506bb` (Phase 00 baseline) |
| Current state | uncommitted (no commit authorized) |
| Executor / Reviewer | Kilo agent / awaiting human review |
| Status | **CONDITIONAL** — see §10 gate caveats |

## 2. Goal and scope

- **Agreed goal:** add the Connection entity, server-side service, outbound policy, additive schema, CRUD routes, and idempotent backfill — without converting production reads.
- **Implemented:** items 1–6 of the Phase 02 brief (data, service, presets, outbound, API, backfill/flag).
- **Deliberately NOT implemented:** Gemini/DeepSeek presets beyond declarative custom placeholders; model discovery over the wire; production switch of `loadAiConfig`; UI work; any destructive change to `ai_configs`.
- **Deviation:** RLS cross-account tests are not automated (see §10/§11) — no live-DB test harness exists in this repo; policies mirror the proven `ai_configs` pattern instead. `CONNECTION_FINGERPRINT_SALT` falls back to empty salt in dev if unset (logged-safe, deterministic within a process).

## 3. Result summary

The multi-provider foundation is now in place: a new `ai_provider_connections` table with RLS, server-only runtime loading, safe DTO reads, admin-gated CRUD behind `AI_MULTI_PROVIDER_ENABLED=false`, a centralized SSRF policy client with injectable resolver/transport, and an idempotent backfill over legacy configs — all additive. The production AI path (draft / auto-reply / playground / KB) is byte-for-byte unchanged and still reads `ai_configs`. 861 tests pass, typecheck clean, lint at baseline.

## 4. Decisions

| Decision | Reason | Reference |
|---|---|---|
| `protocol` CHECK limited to `('openai','anthropic')` in 040 | Only adapters that exist today; widen in 041+ with the Phase 03/04 adapters — avoids a column rewrite later | ADR-001, additive discipline |
| Fingerprint = SHA-256 over (account, preset, root, key, server salt) | Non-reversible, used only for invalidation; never returned to client | SECURITY §3.2 |
| Custom presets exist declaratively but are `deployment_opt_in` AND rejected before any DNS call | ADR-007: no per-tenant bypass of outbound policy | `presets.ts` |
| Backfill names `Assistant (Chat)` / `Assistant (Embeddings)` deterministically and looks up by (account, name) | Idempotent re-run = zero new rows even when both connections share one preset | DATA contract §15 |
| Legacy GCM ciphertext is reused as-is; legacy CBC rows are decrypt-reencrypt to GCM in-place | No plaintext in logs; authenticated format going forward | `encryption.ts` header docs |

## 5. Files

| File | A/M | Purpose |
|---|---|---|
| `supabase/migrations/040_ai_provider_connections.sql` | A | Connections table + RLS + trigger; 6 additive nullable `ai_configs` columns. No old column touched. |
| `src/lib/ai/connections/types.ts` | A | `SafeConnection` / `RuntimeConnection` / `ConnectionRow` domain types |
| `src/lib/ai/connections/service.ts` | A | Create/update payloads: fixed-root rejection, encryption, fingerprinting |
| `src/lib/ai/connections/loader.ts` | A | server-only `loadRuntimeConnection` (narrow decrypt) + `listSafeConnections` (never selects ciphertext) |
| `src/lib/ai/connections/backfill.ts` | A | Idempotent legacy → connections backfill, CBC→GCM upgrade, counts-only report |
| `src/lib/ai/providers/presets.ts` | A | Declarative preset registry (fixed roots server-defined; custom placeholders gated) |
| `src/lib/ai/outbound/url-policy.ts` | A | Scheme/port/credential/fragment checks, RFC-range IPv4 (incl. CGNAT/metadata/TEST-NETs) + IPv6 (incl. IPv4-mapped), all-address DNS rejection, manual redirect, timeout, injectable resolver/transport |
| `src/app/api/ai/connections/route.ts` | A | GET (member, safe DTO only) / POST (admin, 409 dup name, 201) |
| `src/app/api/ai/connections/[id]/route.ts` | A | PATCH (admin; absent key keeps stored secret; null-key clear rejected) / DELETE (admin; 409 when in use by chat or embeddings; UUID validated before DB interpolation) |
| `.env.local.example` | M | Documented 5 new vars with safe defaults (all off) |
| `connections/service.test.ts`, `connections/backfill.test.ts`, `outbound/url-policy.test.ts` | A | 27 new unit tests |

No user-owned file was previously modified; nothing was overwritten. All Phase 01 files untouched by this phase.

## 6. Flow before/after

Unchanged production flow: `route → loadAiConfig(ai_configs, decrypt) → generateReply → registry`. New, dormant behind flag: `route → ai_provider_connections → loadRuntimeConnection`; `POST/PATCH/DELETE /api/ai/connections`; backfill admin tooling. Nothing yet consumes `RuntimeConnection` (Phase 03+ wires generation).

## 7. Data and migration

- **migration:** `040_ai_provider_connections.sql` — append-only. NOT yet applied to any database (see verification below).
- **forward behavior:** new table + nullable columns; CHECKs on protocol/status; UNIQUE(account_id, name); `updated_at` trigger follows the repo pattern; `references … on delete` intentionally **not set** on the two config→connection FKs (restrict-by-default: deletion blocked at service layer with 409; DB FK would also block since no `on delete cascade`).
- **backfill/idempotency:** `backfillProviderConnections()` — looked up by (account, deterministic name); second pass = skips only (unit-tested 4 ways). Legacy CBC rows upgraded to GCM. Corrupt rows counted, old row NOT rewritten, never throws the batch away.
- **legacy compatibility:** all six legacy columns remain the source of truth for production reads; flag OFF means the new routes return 404 and nothing else changes.
- **rollback:** schema is additive — rollback is flag-off + code revert; the new table/columns can remain unused. No destructive down-migration is proposed (per roadmap §6/DECISIONS).
- **counts/verification:** migration was NOT executed against a live Supabase from this session (no DB access authorized) — application + `before/after counts` rehearsal is a Phase 06 gate item.

## 8. Security and privacy

- **secrets handling:** key is encrypted with existing AES-256-GCM before any DB write (route → service); GET paths never `select` the ciphertext column; `RuntimeConnection` is `server-only`-imported and never serialized; PATCH cannot wipe a secret accidentally (null → explicit 400; absent → keep); no plaintext in any log path (backfill logs messages only).
- **authorization/RLS:** SELECT any member; INSERT/UPDATE/DELETE admin+; account_id scoped in every query string as well as RLS; cross-account UUIDs resolve as not-found (404) via the same query.
- **outbound/SSRF:** every destination goes `validateUrl → resolveTarget → sendOutbound`; https-only; `user:pass@`, `#fragment`, non-443 ports blocked; hosts on a deployment allowlist only; localhost blocked unless deployment opt-in; **every** A **and** AAAA answer is classified (not the first-only); IPv4-mapped IPv6 unwrapped; `redirect: 'manual'`; timeout enforced via AbortController; 2 MB size ceiling constant exported (stream enforcement is Phase 03's wrapper job — documented debt).
- **redaction/logging:** errors carry public message + code only; fingerprint is never in DTOs.
- **rate/time/size limits:** `RATE_LIMITS.adminAction` on every connection mutation; per-call timeout env-overridable.
- **Remaining findings:** (1) DNS-rebinding TOCTOU is **not closed** without pinned-resolution transport or egress proxy — documented honestly: custom endpoints are disabled by default and any custom-root deployment MUST use the allowlist (`AI_ENDPOINT_ALLOWLIST`) and network isolation; (2) response byte cap enforced post-the-fetch body size check — completed during Phase 03's stream limits; (3) fingerprint hash is salted-SHA256 (not an HMAC primitive) — sufficient per the key's high entropy, recorded in case a reviewer prefers `crypto.createHmac`.

## 9. Tests

| Test / file | Scenario | Result |
|---|---|---|
| `service.test.ts` (8) | create: encrypt + fingerprint, fixed-root rejection, empty key, patch semantics incl. null-key rejection | pass |
| `url-policy.test.ts` (13) | schemes, creds-in-URL, fragment, localhost, ports, IPv4 private/loopback/metadata/CGNAT/TEST-NET ranges, IPv6 loopback/ULA/link-local/multicast/mapped-v4, multi-answer DNS (public+private→block) | pass |
| `backfill.test.ts` (5) | one-pass create chat+embed, second-pass zero-insert idempotency, CBC→GCM upgrade, identical-key single-connection path | pass |
| all pre-existing tests | regression | **84 files / 861 tests pass** |

### Command results (actually run)

| Command | Exit | Result |
|---|---:|---|
| `npx vitest run` | 0 | 861 passed / 84 files (10–26 s runs, twice) |
| `npx vitest run src/lib/ai out/src/lib/ai/outbound …` | 0 | targeted reruns during development |
| `npm run typecheck` | 0 | clean |
| `npm run lint` | 0 | 0 errors / 36 warnings — identical to Phase 00 baseline |
| `npm run format:check` | ≠0 | pre-existing repo-wide drift (453 files at baseline); not touched |
| `npm run build` | — | **Not run** in this session; scheduled for phase-gate/Phase 06 |
| `supabase db push` / migration apply | — | **Not run** — no database access authorized |

## 10. Acceptance criteria

- [x] DB is additive and coexistable (040 adds only; old columns untouched)
- [x] No ciphertext in client read paths (loader never selects it; routes strip)
- [ ] SSRF is DNS+IP classified (done) **and** validated against a live DB… — automated RLS/policy cross-account SQL test is **not in place** (no harness; see debt §13)
- [x] Backfill idempotent (proven twice in unit) and legacy loader still serves all traffic under flag-off

## 11. Risks and limits

| Risk/limit | Prob. | Impact | Mitigation | Owner |
|---|---|---|---|---|
| Migration untested against real Supabase (RLS syntax, pgvector-style ops) | mid | low (additive) | Staging rehearsal planned Phase 06 before any enable | ops/human |
| DNS rebinding TOCTOU | low (default on public presets) | high if custom enabled | Allowlist + deployment flags (default off) + firewall guidance in SECURITY §4.4; pinned transport later | Phase 06 |
| RLS policies mirror proven patterns but have no automated cross-account test | mid | mid | Manual SQL verification in staging + Phase 06 gate checklist | human reviewer |
| Both OpenAI chat + OpenAI embeddings share account names (Chat/Embeddings) correctly but presets collide | low | low | Lookup is (account, name), not (account, preset) — unit-tested | — |
| `.or()` filter string interpolation in DELETE | low | mid | UUID regex validated before interpolation; `account_id` scoping added | — |

## 12. Rollback

1. **Code rollback:** revert the 9 added/modified files above — no dependency, no shared module change, so any earlier commit stays valid.
2. **Feature flag rollback (default already off):** set `AI_MULTI_PROVIDER_ENABLED=false` → new routes return 404; production path unchanged.
3. **Schema:** 040 is append-only; leave it in place (no emergency `drop`). Columns are nullable; legacy code ignores them. Contract removal is a separate future migration per ADR-009.
4. **Backfill rollback:** none needed — backfill only inserts into the new table; `ai_configs` is never mutated (delete or disable the connections rows if desired; FK-less config link columns can't be dangling because nothing links them yet).

## 13. Questions and follow-ups

- **Blockers:** none; the phase is functionally complete as an additive foundation.
- **Out of scope (next phases):** discovery wire implementation (03), Gemini/Anthropic pagination (04), embeddings dimension gate (05), E2E + staging rehearsal (06).
- **Debt** (needs owner/date): RLS integration tests (Phase 06 candidate); byte-limited JSON streaming in the policy transport (with Phase 03); HMAC-vs-digest decision for fingerprint (reviewer's call, cheap change).

## 14. Transition recommendation

**GO with conditions** — proceed to Phase 03 after a human: (a) applies `040` on a staging DB and runs the manual RLS spot-check (`member from account A gets 404 for account B connection`), and (b) reviews the two security findings in §8. The repo itself remains safe: the flag is off and production AI behavior is unchanged.
