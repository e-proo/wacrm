'use client';

import { useCallback, useRef, useState } from 'react'
import type { CatalogState } from './model-combobox'

// ============================================================
// Client-side read-through cache for the per-connection model catalog.
//
// Goal (Phase 05): fetch each provider's model list AT MOST once per
// credential revision — never on every render, never on every field
// focus. Layers:
//   1. in-memory store (per mount)
//   2. localStorage (persists across reloads; keyed by
//      accountId:connectionId and bound to the connection's
//      `updatedAt` token — editing key/root/preset bumps updatedAt
//      in the list payload, which invalidates the stale entry and
//      forces a background refetch; deleting a connection just leaves
//      an orphan key that prunes drop)
//   3. the server DB catalog cache via GET …/models (zero provider
//      calls — it only ever serves what a previous Verify/test stored)
// A "Refresh" action goes through POST discover-models?force=true —
// the ONLY path that may spend a provider request.
// ============================================================

interface CacheEntry extends CatalogState {
  token: string
  savedAt: number
}

const LS_KEY = 'wacrm.ai.modelCatalogs'
const MEM = new Map<string, CacheEntry>()
const MAX_ENTRIES = 16
const ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000 // localStorage copies go stale after a day

function lsKey(accountId: string, connId: string): string {
  return `${accountId}:${connId}`
}

function readPersisted(accountId: string, connId: string): CacheEntry | null {
  const key = lsKey(accountId, connId)
  const inMem = MEM.get(key)
  if (inMem) return inMem
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const all = JSON.parse(raw) as Record<string, CacheEntry>
    const entry = all?.[key]
    if (!entry || typeof entry.token !== 'string' || !Array.isArray(entry.models)) return null
    if (Date.now() - entry.savedAt > ENTRY_MAX_AGE_MS) return null
    MEM.set(key, entry)
    return entry
  } catch {
    return null
  }
}

function writePersisted(accountId: string, connId: string, entry: CacheEntry): void {
  const key = lsKey(accountId, connId)
  MEM.set(key, entry)
  try {
    const raw = localStorage.getItem(LS_KEY)
    const all = (raw ? JSON.parse(raw) : {}) as Record<string, CacheEntry>
    all[key] = entry
    // prune: keep the freshest MAX_ENTRIES by savedAt
    const pruned = Object.fromEntries(
      Object.entries(all)
        .sort(([, a], [, b]) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
        .slice(0, MAX_ENTRIES),
    )
    localStorage.setItem(LS_KEY, JSON.stringify(pruned))
  } catch {
    // Private mode / quota — memory cache still works this mount.
  }
}

/** Drop a connection's caches (after delete) so a re-created id cannot
 *  serve the removed connection's list. */
export function evictCatalog(accountId: string, connId: string): void {
  MEM.delete(lsKey(accountId, connId))
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return
    const all = JSON.parse(raw) as Record<string, CacheEntry>
    if (all[lsKey(accountId, connId)]) {
      delete all[lsKey(accountId, connId)]
      localStorage.setItem(LS_KEY, JSON.stringify(all))
    }
  } catch {
    // best-effort
  }
}

const toState = (e: CacheEntry): CatalogState => ({
  models: e.models,
  fetchedAt: e.fetchedAt,
  stale: e.stale,
  errorCode: e.errorCode,
})

export interface ModelCatalogCache {
  catalogs: Record<string, CatalogState>
  /** Read-through: memory → localStorage → server cache (GET, no provider). `token` = connection.updatedAt. */
  ensure: (connId: string, token: string) => Promise<void>
  /** Explicit user action: POST discover with force_refresh — may hit the provider. */
  refresh: (connId: string, token: string) => Promise<{ ok: boolean; error?: string }>
  busy: string | null
}

export function useModelCatalogCache(accountId: string | null | undefined): ModelCatalogCache {
  const [catalogs, setCatalogs] = useState<Record<string, CatalogState>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const inflight = useRef(new Map<string, Promise<void>>())

  const ensure = useCallback(
    async (connId: string, token: string) => {
      if (!accountId || !connId) return
      const cached = readPersisted(accountId, connId)
      if (cached && cached.token === token) {
        setCatalogs((p) => ({ ...p, [connId]: toState(cached) }))
        return
      }
      const running = inflight.current.get(connId)
      if (running) {
        await running
        return
      }
      const p = (async () => {
        try {
          const res = await fetch(`/api/ai/connections/${connId}/models`)
          if (!res.ok) return
          const d = await res.json()
          const entry: CacheEntry = {
            models: Array.isArray(d.models) ? d.models : [],
            fetchedAt: d.fetchedAt ?? null,
            stale: d.stale === true,
            errorCode: d.errorCode ?? null,
            token,
            savedAt: Date.now(),
          }
          writePersisted(accountId, connId, entry)
          setCatalogs((prev) => ({ ...prev, [connId]: toState(entry) }))
        } catch {
          // Network hiccup — comboboxes fall back to manual entry.
        } finally {
          inflight.current.delete(connId)
        }
      })()
      inflight.current.set(connId, p)
      await p
    },
    [accountId],
  )

  const refresh = useCallback(
    async (connId: string, token: string) => {
      if (!accountId || !connId) return { ok: false, error: 'no-connection' }
      setBusy(connId)
      try {
        const res = await fetch(`/api/ai/connections/${connId}/discover-models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force_refresh: true }),
        })
        const d = await res.json().catch(() => ({}))
        const models = Array.isArray(d.catalog?.models) ? d.catalog.models : []
        const entry: CacheEntry = {
          models,
          fetchedAt: d.catalog?.fetchedAt ?? null,
          stale: d.stale === true || !!d.error?.code,
          errorCode: d.error?.code ?? null,
          token,
          savedAt: Date.now(),
        }
        writePersisted(accountId, connId, entry)
        setCatalogs((prev) => ({ ...prev, [connId]: toState(entry) }))
        // The POST may have returned the last-good (stale) catalog even
        // on error (FR-MOD-06); ok reflects the auth probe, not staleness.
        return { ok: !!d.connection_ok, error: d.error?.code }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'network' }
      } finally {
        setBusy(null)
      }
    },
    [accountId],
  )

  return { catalogs, ensure, refresh, busy }
}
