import { supabaseAdmin } from '@/lib/ai/admin-client'
import type { ToolContext, ToolResult } from './executors'
import { executeCoverageDirectionalProposal } from './coverage-directional'
import type { CoverageMethod } from '@/lib/services/coverage/attributes'

type ProposalKind = 'offer' | 'request'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CANONICAL_ATTRIBUTE_KEYS = new Set([
  'coverage_scope',
  'coverage_country',
  'receive_region_id',
  'receive_method',
  'pay_region_id',
  'pay_method',
])

const REGION_ALIAS_KEYS = new Set([
  'pay_region',
  'pay_region_name',
  'pay_location',
  'receive_region',
  'receive_region_name',
  'receive_location',
])

interface RegionRow {
  id: string
  code: string
  name: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
}

export function normalizeCoverageProposalMethod(value: unknown): CoverageMethod | null {
  if (value === undefined || value === null || value === '') return 'any'
  if (typeof value !== 'string') return null

  const normalized = normalizeText(value).replace(/[_-]+/g, ' ')
  const aliases: Record<string, CoverageMethod> = {
    cash: 'cash',
    كاش: 'cash',
    نقد: 'cash',
    نقدا: 'cash',
    networks: 'networks',
    network: 'networks',
    شبكات: 'networks',
    شبكة: 'networks',
    شبكه: 'networks',
    remittance: 'remittance',
    remittances: 'remittance',
    حوالة: 'remittance',
    حواله: 'remittance',
    حوالات: 'remittance',
    'bank deposit': 'bank_deposit',
    'ايداع بنكي': 'bank_deposit',
    ايداع: 'bank_deposit',
    any: 'any',
    اي: 'any',
  }
  return aliases[normalized] ?? null
}

async function resolveRegionId(
  ctx: ToolContext,
  raw: unknown,
  leg: 'pay' | 'receive',
): Promise<{ ok: true; id: string | null } | { ok: false; result: ToolResult<never> }> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, id: null }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'INVALID_COVERAGE_ATTRIBUTES',
        message: `${leg}_region must be a region id or name.`,
      },
    }
  }
  if (UUID_RE.test(raw)) return { ok: true, id: raw }

  const { data, error } = await supabaseAdmin()
    .from('coverage_regions')
    .select('id, code, name')
    .eq('account_id', ctx.accountId)
    .eq('status', 'active')
  if (error) {
    console.error('[tool] coverage proposal region resolution failed:', error)
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'COVERAGE_REGION_READ_FAILED',
        message: 'Could not resolve coverage regions.',
      },
    }
  }

  const needle = normalizeText(raw)
  const rows = (data ?? []) as RegionRow[]
  const exact = rows.filter(
    (row) => normalizeText(row.code) === needle || normalizeText(row.name) === needle,
  )
  const candidates = exact.length
    ? exact
    : rows.filter((row) => {
        const code = normalizeText(row.code)
        const name = normalizeText(row.name)
        return code.includes(needle) || name.includes(needle) || needle.includes(code) || needle.includes(name)
      })

  if (candidates.length !== 1) {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: leg === 'pay' ? 'PAY_REGION_NOT_RESOLVED' : 'RECEIVE_REGION_NOT_RESOLVED',
        message:
          candidates.length > 1
            ? `Ambiguous coverage region: ${raw}`
            : `Coverage region not found: ${raw}`,
      },
    }
  }
  return { ok: true, id: candidates[0].id }
}

/**
 * Proposal-boundary compatibility layer.
 *
 * The authoritative directional executor remains strict. This adapter only
 * canonicalizes common model/provider representations before they reach that
 * strict boundary: human region names are resolved server-side and Arabic
 * method labels are mapped to the closed enum. Unknown attribute keys still
 * fail closed instead of being silently discarded.
 */
export async function executeCoverageProposalResilient(
  ctx: ToolContext,
  rawArgs: Record<string, unknown>,
  invokedAs: ProposalKind,
): Promise<ToolResult<unknown>> {
  const rawAttributes = isRecord(rawArgs.attributes) ? rawArgs.attributes : {}
  const unknownKeys = Object.keys(rawAttributes).filter(
    (key) => !CANONICAL_ATTRIBUTE_KEYS.has(key) && !REGION_ALIAS_KEYS.has(key),
  )
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      data: {
        errors: unknownKeys.map((field) => ({
          field,
          code: 'UNKNOWN_KEY',
          message: `Unknown coverage attribute: ${field}`,
        })),
      },
      safe_to_show: true,
      code: 'INVALID_COVERAGE_ATTRIBUTES',
      message: 'Coverage legs are invalid.',
    }
  }

  const payRegionRaw =
    rawAttributes.pay_region_id ??
    rawAttributes.pay_region ??
    rawAttributes.pay_region_name ??
    rawAttributes.pay_location
  const receiveRegionRaw =
    rawAttributes.receive_region_id ??
    rawAttributes.receive_region ??
    rawAttributes.receive_region_name ??
    rawAttributes.receive_location

  const [payRegion, receiveRegion] = await Promise.all([
    resolveRegionId(ctx, payRegionRaw, 'pay'),
    resolveRegionId(ctx, receiveRegionRaw, 'receive'),
  ])
  if (!payRegion.ok) return payRegion.result
  if (!receiveRegion.ok) return receiveRegion.result

  const payMethod = normalizeCoverageProposalMethod(rawAttributes.pay_method)
  const receiveMethod = normalizeCoverageProposalMethod(rawAttributes.receive_method)
  if (!payMethod || !receiveMethod) {
    return {
      ok: false,
      data: {
        errors: [
          ...(!payMethod
            ? [{ field: 'pay_method', code: 'NOT_IN_ENUM', message: 'Unsupported pay method.' }]
            : []),
          ...(!receiveMethod
            ? [{ field: 'receive_method', code: 'NOT_IN_ENUM', message: 'Unsupported receive method.' }]
            : []),
        ],
      },
      safe_to_show: true,
      code: 'INVALID_COVERAGE_ATTRIBUTES',
      message: 'Coverage legs are invalid.',
    }
  }

  const canonicalAttributes: Record<string, unknown> = {
    ...(rawAttributes.coverage_scope !== undefined
      ? { coverage_scope: rawAttributes.coverage_scope }
      : {}),
    ...(rawAttributes.coverage_country !== undefined
      ? { coverage_country: rawAttributes.coverage_country }
      : {}),
    ...(payRegion.id ? { pay_region_id: payRegion.id } : {}),
    pay_method: payMethod,
    ...(receiveRegion.id ? { receive_region_id: receiveRegion.id } : {}),
    receive_method: receiveMethod,
  }

  if (
    rawAttributes.pay_region !== undefined ||
    rawAttributes.receive_region !== undefined ||
    (typeof rawAttributes.pay_region_id === 'string' && !UUID_RE.test(rawAttributes.pay_region_id)) ||
    (typeof rawAttributes.receive_region_id === 'string' && !UUID_RE.test(rawAttributes.receive_region_id)) ||
    rawAttributes.pay_method !== payMethod ||
    rawAttributes.receive_method !== receiveMethod
  ) {
    console.info('[tool] coverage proposal canonicalized model-supplied coverage legs')
  }

  return executeCoverageDirectionalProposal(
    ctx,
    { ...rawArgs, attributes: canonicalAttributes } as never,
    invokedAs,
  )
}
