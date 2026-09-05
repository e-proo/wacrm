// ============================================================
// API-root path joining for protocol adapters.
//
// Contract (Master §9.4): the stored `api_root` is the complete API
// root INCLUDING the version segment a provider requires (e.g.
// `https://api.openai.com/v1/` or `https://api.deepseek.com/`).
// Adapters join *relative* endpoint paths (`chat/completions`,
// `models`, `embeddings`) onto that root. This helper guarantees:
//   - the root's path prefix is preserved (a gateway under
//     `/t/example/v1/` keeps its `/t/example` prefix),
//   - a missing trailing slash never swallows the last segment,
//   - a `v1/` prefix in the appended path is collapsed once when the
//     root already ends in `v1` (so `/v1/` + `v1/models` can't become
//     the classic `/v1/v1/models`),
//   - absolute/protocol-smuggling paths are rejected.
// ============================================================

/** Normalize a root to end with exactly one trailing slash. */
export function ensureTrailingSlash(root: string | URL): string {
  const s = typeof root === 'string' ? root : root.toString()
  return s.endsWith('/') ? s : `${s}/`
}

/**
 * Join a relative endpoint path onto an API root. Throws on absolute
 * paths, scheme-bearing paths, `..` traversal, or an empty path.
 */
export function joinApiPath(root: string | URL, path: string): URL {
  const trimmed = path.trim()
  if (!trimmed) throw new Error('endpoint path must not be empty')
  // Reject anything that could escape the root: absolute URL, scheme,
  // leading slash, or traversal.
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/') || trimmed.includes('..')) {
    throw new Error(
      `endpoint path must be relative to the API root (got '${trimmed}')`,
    )
  }

  const base = ensureTrailingSlash(root)
  const baseIsVersioned = /\/v\d+\/$/i.test(base)
  const finalPath =
    baseIsVersioned && /^v\d+\//i.test(trimmed) ? trimmed.replace(/^v\d+\//i, '') : trimmed
  return new URL(finalPath, base)
}
