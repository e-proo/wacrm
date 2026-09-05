import type { ModelCatalog, ModelInfo } from './model-types'
import { CATALOG_SCHEMA_VERSION } from './contract'

// ============================================================
// Model catalog normalization — OpenAI-shaped `GET /models` responses
// into the single internal `ModelInfo` contract (FR-MOD-05).
//
// Documented compatibility subset: `{ data: [{ id, created?,
// owned_by? }] }`. Extra fields are dropped; missing metadata is the
// NORMAL case for compatible gateways and yields `unknown`
// capabilities — never `unsupported` (ADR-005). Model ids are stored
// case-sensitively and dedup keeps the first occurrence. The list is
// size-capped and stably sorted so refreshes don't churn the UI.
// ============================================================

const MAX_ID_LEN = 200
const MAX_OWNER_LEN = 100
export const MAX_CATALOG_MODELS = 500

interface RawModelEntry {
  id?: unknown
  created?: unknown
  owned_by?: unknown
}

/**
 * Normalize a parsed OpenAI-compatible `/models` payload.
 * Throws on structurally invalid payloads (`data` missing/not an
 * array) so the caller records a safe `AI_PROVIDER_MALFORMED_RESPONSE`
 * and keeps the previous cache — a 404/unsupported endpoint is handled
 * BEFORE this call and is a different outcome.
 */
export function normalizeOpenAiModels(
  raw: { data?: unknown } | null,
  opts: { now?: () => string } = {},
): ModelCatalog {
  if (!raw || !Array.isArray(raw.data)) {
    throw new Error('models payload missing a `data` array')
  }
  const byId = new Map<string, ModelInfo>()
  let truncated = false
  for (const entry of raw.data as RawModelEntry[]) {
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id || id.length > MAX_ID_LEN) continue
    if (byId.has(id)) continue // dedupe, case-sensitive, first wins
    if (byId.size >= MAX_CATALOG_MODELS) {
      truncated = true
      break
    }
    byId.set(id, {
      id,
      displayName: id.split('/').pop() ?? id,
      capabilities: {
        chat: 'unknown',
        embeddings: 'unknown',
        modelDiscovery: 'supported',
      },
      ownedBy:
        typeof entry.owned_by === 'string' && entry.owned_by.length <= MAX_OWNER_LEN
          ? entry.owned_by
          : undefined,
    })
  }
  const models = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    models,
    fetchedAt: (opts.now ?? (() => new Date().toISOString()))(),
    source: 'provider',
    completeness: truncated ? 'bounded' : 'complete',
  }
}

// ------------------------------------------------------------
// Gemini native catalog. Capabilities are derived ONLY from the
// authoritative `supportedGenerationMethods` array (per ADR-005: the
// array is official metadata; a name heuristic may reorder but never
// block). Ids keep their `models/...` form in `rawProviderId` and are
// stored bare; the catalog is complete unless pages hit the cap.
// ------------------------------------------------------------

interface RawGeminiModel {
  name?: unknown
  displayName?: unknown
  supportedGenerationMethods?: unknown
  inputTokenLimit?: unknown
  outputTokenLimit?: unknown
}

export function normalizeGeminiModels(
  pages: { models?: unknown[] }[],
  opts: { now?: () => string } = {},
): ModelCatalog {
  const byId = new Map<string, ModelInfo>()
  let capped = false
  pageLoop: for (const page of pages) {
    for (const entry of (page?.models ?? []) as RawGeminiModel[]) {
      const rawName = typeof entry.name === 'string' ? entry.name.trim() : ''
      if (!rawName) continue
      const id = (rawName.startsWith('models/') ? rawName.slice(7) : rawName).trim()
      if (!id || id.length > MAX_ID_LEN) continue
      const methods = Array.isArray(entry.supportedGenerationMethods)
        ? (entry.supportedGenerationMethods as unknown[])
        : null
      if (byId.size >= MAX_CATALOG_MODELS) {
        capped = true
        break pageLoop
      }
      byId.set(id, {
        id,
        displayName:
          typeof entry.displayName === 'string' && entry.displayName
            ? entry.displayName.slice(0, MAX_ID_LEN)
            : id.split('/').pop()!,
        capabilities: {
          // Official array present → authoritative; absent (custom
          // gateway without metadata) → unknown (ADR-005).
          chat: methods === null ? 'unknown' : methods.includes('generateContent') ? 'supported' : 'unsupported',
          embeddings: methods === null ? 'unknown' : methods.includes('embedContent') ? 'supported' : 'unsupported',
          modelDiscovery: 'supported',
        },
        inputTokenLimit:
          typeof entry.inputTokenLimit === 'number' && entry.inputTokenLimit > 0
            ? entry.inputTokenLimit
            : undefined,
        outputTokenLimit:
          typeof entry.outputTokenLimit === 'number' && entry.outputTokenLimit > 0
            ? entry.outputTokenLimit
            : undefined,
        rawProviderId: rawName,
      })
    }
  }
  const models = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    models,
    fetchedAt: (opts.now ?? (() => new Date().toISOString()))(),
    source: 'provider',
    completeness: capped ? 'bounded' : 'complete',
  }
}

// ------------------------------------------------------------
// Anthropic catalog. `/v1/models` entries carry `id`, `display_name`,
// `type` — official metadata that does NOT include capabilities, so
// chat stays `supported` only for `type === 'model'` (official field)
// and embeddings `unknown` (absence ≠ proof of absence, ADR-005).
// Pagination is cursor-style (`has_more` + `after`), resolved by the
// caller; the normalizer merges pages.
// ------------------------------------------------------------

interface RawAnthropicModel {
  id?: unknown
  display_name?: unknown
  type?: unknown
}

export function normalizeAnthropicModels(
  pages: { data?: unknown[] }[],
  opts: { now?: () => string } = {},
): ModelCatalog {
  const byId = new Map<string, ModelInfo>()
  let capped = false
  pageLoop: for (const page of pages) {
    for (const entry of (page?.data ?? []) as RawAnthropicModel[]) {
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      if (!id || id.length > MAX_ID_LEN) continue
      if (byId.has(id)) continue
      if (byId.size >= MAX_CATALOG_MODELS) {
        capped = true
        break pageLoop
      }
      const isModel = entry.type === 'model'
      byId.set(id, {
        id,
        displayName:
          typeof entry.display_name === 'string' && entry.display_name
            ? entry.display_name.slice(0, MAX_ID_LEN)
            : id,
        capabilities: {
          chat: isModel ? 'supported' : 'unknown',
          embeddings: 'unknown', // no capability metadata in the list
          modelDiscovery: 'supported',
        },
      })
    }
  }
  const models = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    models,
    fetchedAt: (opts.now ?? (() => new Date().toISOString()))(),
    source: 'provider',
    completeness: capped ? 'bounded' : 'complete',
  }
}

// ------------------------------------------------------------
// Cache envelope stored in `ai_provider_connections.catalog`.
// Bounded by construction (MAX_CATALOG_MODELS + field-length caps).
// ------------------------------------------------------------

export interface CatalogEnvelope {
  /** Normalizer rules version; bump makes old envelopes stale. */
  v: number
  fetchedAt: string
  /** Connection fingerprint observed at fetch time — mismatch means
   *  the key/root/protocol changed and the catalog is no longer fresh. */
  fingerprint: string
  catalog: ModelCatalog
}

export function packCatalogEnvelope(
  catalog: ModelCatalog,
  fingerprint: string,
): CatalogEnvelope {
  return { v: CATALOG_SCHEMA_VERSION, fetchedAt: catalog.fetchedAt, fingerprint, catalog }
}

/** Strict parse: anything malformed returns null (→ treated as absent). */
export function unpackCatalogEnvelope(raw: unknown): CatalogEnvelope | null {
  if (!raw || typeof raw !== 'object') return null
  const env = raw as Partial<CatalogEnvelope>
  if (env.v !== CATALOG_SCHEMA_VERSION) return null
  if (typeof env.fetchedAt !== 'string' || typeof env.fingerprint !== 'string') return null
  const cat = env.catalog
  if (!cat || !Array.isArray(cat.models)) return null
  // Re-assert the size cap on read — a row edited under an older/bigger
  // limit must not blow up the client payload.
  if (cat.models.length > MAX_CATALOG_MODELS) return null
  for (const m of cat.models as ModelInfo[]) {
    if (typeof m?.id !== 'string' || !m.id) return null
  }
  return {
    ...env,
    catalog: { ...cat, models: cat.models as ModelInfo[] },
  } as CatalogEnvelope
}

// ------------------------------------------------------------
// Freshness decisions (pure; safe to import from anywhere — no
// loader/DB dependencies, which would create a cycle).
// ------------------------------------------------------------

/** 15 minutes — the conservative default from docs §12.4. */
export const CATALOG_TTL_MS = 15 * 60 * 1000

/**
 * Decide whether the stored catalog counts as fresh: version match,
 * fingerprint match, and TTL not exceeded. Returns the parsed
 * envelope, or null when absent/rotated/expired (i.e. refresh time).
 */
export function catalogIsFresh(
  rawCatalog: unknown,
  currentFingerprint: string,
  nowMs: number,
  ttlMs: number = CATALOG_TTL_MS,
): CatalogEnvelope | null {
  const env = unpackCatalogEnvelope(rawCatalog)
  if (!env) return null
  if (env.fingerprint !== currentFingerprint) return null
  const fetchedMs = Date.parse(env.fetchedAt)
  if (!Number.isFinite(fetchedMs) || nowMs - fetchedMs > ttlMs) return null
  return env
}

/** Stale flag for display: a catalog is present but not fresh. */
export function catalogIsStale(
  rawCatalog: unknown,
  currentFingerprint: string,
  nowMs: number,
): boolean {
  if (!unpackCatalogEnvelope(rawCatalog)) return false
  return catalogIsFresh(rawCatalog, currentFingerprint, nowMs) === null
}
