// Shared slug helpers for the Phase 4 builder.

/**
 * The slug pattern the builder accepts: lowercase alphanumeric
 * with optional interior hyphens, 1-62 chars.
 */
export const SLUG_PATTERN_BUILDER = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/**
 * Derive a slug from a display name when the caller omits one.
 * Falls back to 'agent' when the name has no latin characters.
 */
export function deriveSlugFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'agent'
  )
}
