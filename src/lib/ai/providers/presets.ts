import type { ProviderProtocol } from './contract'

// ============================================================
// Preset registry — declarative, server-defined provider metadata.
//
// Presets do NOT carry secrets; they define protocol, default API
// root, auth strategy, and whether the root is fixed (server-owned
// official API) or custom (admin-supplied gateway — accepted only
// when the deployment opts in AND every request passes the outbound
// SSRF policy).
// ============================================================

export type AuthStrategy = 'bearer' | 'x_api_key' | 'query_key' | 'x_goog_api_key'
export type ApiRootMode = 'fixed' | 'custom'
export type Availability = 'public' | 'deployment_opt_in'

export interface ProviderPreset {
  readonly id: string
  readonly label: string
  readonly protocol: ProviderProtocol
  readonly defaultApiRoot: string
  readonly apiRootMode: ApiRootMode
  readonly authStrategy: AuthStrategy
  readonly availability: Availability
}

// NOTE: defaultApiRoot values are server-defined and validated against
// each provider's official docs at the time of this writing. They are
// NOT secrets and never contain one.
export const PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    defaultApiRoot: 'https://api.openai.com/v1/',
    apiRootMode: 'fixed',
    authStrategy: 'bearer',
    availability: 'public',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    defaultApiRoot: 'https://api.anthropic.com/v1/',
    apiRootMode: 'fixed',
    authStrategy: 'x_api_key',
    availability: 'public',
  },
  // Gemini uses its Native API per ADR-003. The root is the official
  // `generativelanguage.googleapis.com/v1beta/` surface — the live
  // endpoint path was confirmed on 2026-09-04 against an unauthenticated
  // GET /v1beta/models (403 per policy) and documented in the Phase 04
  // report; docs.ai re-verification against ai.google.dev is an open
  // human-gate item because full docs were unreachable from the build
  // environment (regional block).
  {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini_native',
    defaultApiRoot: 'https://generativelanguage.googleapis.com/v1beta/',
    apiRootMode: 'fixed',
    authStrategy: 'x_goog_api_key',
    availability: 'public',
  },
  // DeepSeek's official integration docs document an OpenAI-compatible
  // API whose base is `https://api.deepseek.com` (no `/v1` segment;
  // relative paths join to /chat/completions and /models, matching the
  // officially documented endpoints). The root here follows that
  // documented contract; per the docs-pack rule the address must be
  // re-verified against https://api-docs.deepseek.com at release time
  // — the site was unreachable from the build environment, which is
  // logged as a human-gate item in the Phase 03 report.
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    defaultApiRoot: 'https://api.deepseek.com/',
    apiRootMode: 'fixed',
    authStrategy: 'bearer',
    availability: 'public',
  },
  // Custom endpoints — any gateway/relay exposing an official protocol
  // surface (OpenAI-, Anthropic-, or Gemini-shape), e.g.
  // `https://api.b.ai/v1/`. Gated by the deployment flag
  // `AI_CUSTOM_ENDPOINTS_ENABLED` (never tenant-toggleable, ADR-007);
  // at REQUEST time every custom root passes the outbound policy:
  // https-only, port/allowlist rules, and DNS results classified so
  // private/metadata ranges stay blocked unless
  // `AI_PRIVATE_ENDPOINTS_ENABLED` + `AI_ENDPOINT_ALLOWLIST` say
  // otherwise (for 9Router-style LAN gateways).
  {
    id: 'openai_compatible_custom',
    label: 'Custom — OpenAI-compatible',
    protocol: 'openai',
    defaultApiRoot: '',
    apiRootMode: 'custom',
    authStrategy: 'bearer',
    availability: 'deployment_opt_in',
  },
  {
    id: 'anthropic_compatible_custom',
    label: 'Custom — Anthropic-compatible',
    protocol: 'anthropic',
    defaultApiRoot: '',
    apiRootMode: 'custom',
    authStrategy: 'x_api_key',
    availability: 'deployment_opt_in',
  },
  {
    id: 'gemini_compatible_custom',
    label: 'Custom — Gemini-compatible',
    protocol: 'gemini_native',
    defaultApiRoot: '',
    apiRootMode: 'custom',
    authStrategy: 'x_goog_api_key',
    availability: 'deployment_opt_in',
  },
] as const

const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p] as const))

/** Resolve a preset by id. Throws for unknown ids (never falls back). */
export function getPreset(id: string): ProviderPreset {
  const preset = PRESET_BY_ID.get(id)
  if (!preset) {
    throw new Error(`Unknown AI provider preset: ${id}`)
  }
  return preset
}

/**
 * Resolve a preset, enforcing deployment policy. `deployment_opt_in`
 * (custom-root) presets need `customEndpointsEnabled` — regardless of
 * protocol. The private-endpoints flag applies LATER (outbound policy
 * at request time: private IPs), never as a gate on the catalog.
 * Throws on unknown id; returns null when disabled for deployment.
 */
export function resolvePreset(
  id: string,
  opts: { customEndpointsEnabled: boolean; privateEndpointsEnabled: boolean },
): ProviderPreset | null {
  const preset = getPreset(id)
  if (preset.availability === 'deployment_opt_in' && !opts.customEndpointsEnabled) {
    return null
  }
  return preset
}

/**
 * True when the connection's stored root came from a user-editable
 * custom preset (→ the outbound policy MUST validate it on every
 * request). Derived SERVER-SIDE from the stored preset id — never
 * from client input, so a fixed preset can never self-declare custom.
 */
export function isCustomRootPreset(presetId: string): boolean {
  try {
    return getPreset(presetId).apiRootMode === 'custom'
  } catch {
    // Unknown preset ids should not exist (FK to a stored row); treat
    // as custom so the policy validation stays on the safe side.
    return true
  }
}

/** Preset ids that are visible/selectable for this deployment. */
export function listAvailablePresets(opts: {
  customEndpointsEnabled: boolean
  privateEndpointsEnabled: boolean
}): ProviderPreset[] {
  return PRESETS.filter((p) => {
    if (p.availability === 'public') return true
    return resolvePreset(p.id, opts) !== null
  })
}