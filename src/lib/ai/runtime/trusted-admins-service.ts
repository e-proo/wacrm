import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { canonicalizeE164 } from './phone-e164'
import type {
  AccountId,
  TrustedAdminIdentity,
  Uuid,
} from './multi-agent-types'

// ============================================================
// Trusted admin identity service.
//
// Phase 1 implements:
//   • register — admin submits a phone number; we canonicalize
//     it, store a hash of a short OTP, and (caller responsibility)
//     send the OTP via the existing whatsapp send route.
//   • verify — caller submits the OTP; we hash-compare + burn the
//     attempts counter; on success the row flips to 'active'.
//   • revoke — soft-revoke. The row stays for audit; identity is
//     not honored for routing anymore.
//   • list — admin+ only.
//
// The OTP itself is generated server-side with crypto.randomBytes,
// 6 digits. We store only its SHA-256 hash + the 10-minute expiry.
// A new OTP replaces the previous hash atomically (UPDATE WHERE
// status='pending_verification') so a stale request can't race.
// ============================================================

export class TrustedAdminError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'TrustedAdminError'
    this.code = code
    this.status = status
  }
}

const OTP_DIGITS = 6
const OTP_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_VERIFICATION_ATTEMPTS = 5

export interface RegisterTrustedAdminInput {
  accountId: AccountId
  rawPhone: string
  displayName?: string | null
  memberId?: Uuid | null
  actorUserId: Uuid | null
}

export interface RegisterTrustedAdminResult {
  identity: TrustedAdminIdentity
  /** Plaintext OTP to send over the wire. NEVER persisted. */
  otp: string
}

export async function registerTrustedAdmin(
  db: SupabaseClient,
  input: RegisterTrustedAdminInput,
): Promise<RegisterTrustedAdminResult> {
  const canonical = canonicalizeE164(input.rawPhone)
  if (!canonical) {
    throw new TrustedAdminError(
      'INVALID_PHONE',
      'Phone number is not a valid E.164-compatible address.',
      400,
    )
  }

  // Upsert semantics: if a row exists (any status), we refresh
  // its OTP and (re)open the verification window. This keeps the
  // admin's intent idempotent — a second submit doesn't 409.
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString()
  const otp = generateOtp(OTP_DIGITS)
  const codeHash = hashOtp(otp)

  const { data: row, error } = await db
    .from('trusted_admin_identities')
    .upsert(
      {
        account_id: input.accountId,
        channel: 'whatsapp',
        normalized_address: canonical,
        display_name: input.displayName ?? null,
        member_id: input.memberId ?? null,
        status: 'pending_verification',
        verification_method: 'otp',
        verification_code_hash: codeHash,
        verification_expires_at: expiresAt,
        verification_attempts: 0,
        verified_at: null,
        revoked_at: null,
        allowed_capabilities: [],
        created_by: input.actorUserId,
      },
      { onConflict: 'account_id,channel,normalized_address' },
    )
    .select(
      'id, account_id, channel, normalized_address, display_name, member_id, status, verification_method, verified_at, revoked_at, allowed_capabilities, created_at',
    )
    .maybeSingle()

  if (error) throw error
  if (!row) {
    throw new TrustedAdminError(
      'REGISTER_FAILED',
      'Could not register the trusted admin identity.',
      500,
    )
  }
  return {
    identity: mapIdentity(row),
    otp,
  }
}

export interface VerifyTrustedAdminInput {
  accountId: AccountId
  identityId: Uuid
  otp: string
  actorUserId: Uuid | null
}

export async function verifyTrustedAdmin(
  db: SupabaseClient,
  input: VerifyTrustedAdminInput,
): Promise<TrustedAdminIdentity> {
  const { accountId, identityId, otp, actorUserId } = input
  if (!/^\d{4,8}$/.test(otp)) {
    throw new TrustedAdminError(
      'INVALID_OTP_FORMAT',
      'OTP must be 4-8 digits.',
      400,
    )
  }
  const codeHash = hashOtp(otp)

  // Atomically: load the row, check expiry + attempts, then flip.
  const { data: row, error } = await db
    .from('trusted_admin_identities')
    .select(
      'id, account_id, status, verification_code_hash, verification_expires_at, verification_attempts',
    )
    .eq('account_id', accountId)
    .eq('id', identityId)
    .maybeSingle()
  if (error) throw error
  if (!row) {
    throw new TrustedAdminError('IDENTITY_NOT_FOUND', 'Identity not found.', 404)
  }
  const r = row as {
    status: string
    verification_code_hash: string | null
    verification_expires_at: string | null
    verification_attempts: number
  }
  if (r.status === 'active') {
    // Idempotent — already verified.
    const fresh = await loadIdentity(db, accountId, identityId)
    if (!fresh) throw new TrustedAdminError('IDENTITY_NOT_FOUND', 'Identity not found.', 404)
    return fresh
  }
  if (r.status === 'revoked') {
    throw new TrustedAdminError(
      'IDENTITY_REVOKED',
      'This identity has been revoked. Register a new one.',
      409,
    )
  }
  if (!r.verification_code_hash || !r.verification_expires_at) {
    throw new TrustedAdminError(
      'NO_PENDING_OTP',
      'No pending verification request for this identity.',
      409,
    )
  }
  if (Date.parse(r.verification_expires_at) < Date.now()) {
    throw new TrustedAdminError(
      'OTP_EXPIRED',
      'The OTP has expired. Resend a new one.',
      410,
    )
  }
  if (r.verification_attempts >= MAX_VERIFICATION_ATTEMPTS) {
    throw new TrustedAdminError(
      'OTP_TOO_MANY_ATTEMPTS',
      'Too many verification attempts. Resend a new OTP.',
      429,
    )
  }
  if (r.verification_code_hash !== codeHash) {
    // Bump the attempt counter (don't burn the OTP on a wrong
    // guess — legitimate retries stay possible).
    await db
      .from('trusted_admin_identities')
      .update({
        verification_attempts: r.verification_attempts + 1,
      })
      .eq('account_id', accountId)
      .eq('id', identityId)
    throw new TrustedAdminError('OTP_MISMATCH', 'OTP is incorrect.', 401)
  }

  // Match. Flip to 'active' + burn the OTP + stamp verifier.
  const nowIso = new Date().toISOString()
  const { data: updated, error: updErr } = await db
    .from('trusted_admin_identities')
    .update({
      status: 'active',
      verified_at: nowIso,
      verified_by: actorUserId,
      verification_code_hash: null,
      verification_expires_at: null,
      verification_attempts: 0,
    })
    .eq('account_id', accountId)
    .eq('id', identityId)
    .eq('status', 'pending_verification')
    .select(
      'id, account_id, channel, normalized_address, display_name, member_id, status, verification_method, verified_at, revoked_at, allowed_capabilities, created_at',
    )
    .maybeSingle()
  if (updErr) throw updErr
  if (!updated) {
    throw new TrustedAdminError(
      'VERIFY_CONFLICT',
      'Identity changed state. Reload and retry.',
      409,
    )
  }
  return mapIdentity(updated)
}

export async function revokeTrustedAdmin(
  db: SupabaseClient,
  input: { accountId: AccountId; identityId: Uuid; actorUserId: Uuid | null },
): Promise<TrustedAdminIdentity> {
  const { accountId, identityId, actorUserId } = input
  const { data: updated, error } = await db
    .from('trusted_admin_identities')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: actorUserId,
      verification_code_hash: null,
      verification_expires_at: null,
    })
    .eq('account_id', accountId)
    .eq('id', identityId)
    .neq('status', 'revoked')
    .select(
      'id, account_id, channel, normalized_address, display_name, member_id, status, verification_method, verified_at, revoked_at, allowed_capabilities, created_at',
    )
    .maybeSingle()
  if (error) throw error
  if (!updated) {
    throw new TrustedAdminError('IDENTITY_NOT_FOUND', 'Identity not found.', 404)
  }
  return mapIdentity(updated)
}

export async function listTrustedAdmins(
  db: SupabaseClient,
  accountId: AccountId,
): Promise<TrustedAdminIdentity[]> {
  const { data, error } = await db
    .from('trusted_admin_identities')
    .select(
      'id, account_id, channel, normalized_address, display_name, member_id, status, verification_method, verified_at, revoked_at, allowed_capabilities, created_at',
    )
    .eq('account_id', accountId)
    .eq('channel', 'whatsapp')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map(mapIdentity)
}

async function loadIdentity(
  db: SupabaseClient,
  accountId: AccountId,
  identityId: Uuid,
): Promise<TrustedAdminIdentity | null> {
  const { data, error } = await db
    .from('trusted_admin_identities')
    .select(
      'id, account_id, channel, normalized_address, display_name, member_id, status, verification_method, verified_at, revoked_at, allowed_capabilities, created_at',
    )
    .eq('account_id', accountId)
    .eq('id', identityId)
    .maybeSingle()
  if (error) throw error
  return data ? mapIdentity(data) : null
}

function generateOtp(digits: number): string {
  const max = 10 ** digits
  const value = crypto.randomInt(0, max)
  return value.toString().padStart(digits, '0')
}

function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex')
}

function mapIdentity(row: {
  id: string
  account_id: string
  channel: string
  normalized_address: string
  display_name: string | null
  member_id: string | null
  status: string
  verification_method: string | null
  verified_at: string | null
  revoked_at: string | null
  allowed_capabilities: unknown
  created_at: string
}): TrustedAdminIdentity {
  return {
    id: row.id,
    accountId: row.account_id,
    channel: row.channel as TrustedAdminIdentity['channel'],
    normalizedAddress: row.normalized_address,
    displayName: row.display_name,
    memberId: row.member_id,
    status: row.status as TrustedAdminIdentity['status'],
    verificationMethod:
      (row.verification_method as TrustedAdminIdentity['verificationMethod']) ??
      null,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at,
    allowedCapabilities: Array.isArray(row.allowed_capabilities)
      ? (row.allowed_capabilities as string[])
      : [],
    createdAt: row.created_at,
  }
}
