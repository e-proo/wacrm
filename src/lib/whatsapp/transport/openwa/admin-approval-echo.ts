import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound-normalization'

/**
 * Direct, ephemeral OpenWA trusted-admin approval alerts must never be
 * persisted as CRM own-device echoes: they carry an active four-digit PIN.
 * Both the outgoing sender and signed message.sent intake use this reviewed
 * fixed-system format. An account-customized template is not permitted on
 * this channel until a separate secure echo-exclusion contract is available.
 */
export function isSensitiveOpenWAAdminApprovalText(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 30 || value.length > 20000) return false
  const text = value.trim()
  if (!text.startsWith('🔔 *طلب اعتماد جديد*')) return false
  const approve = /^للاعتماد:\s*اعتماد\s+CHG-(\d+)\s+[1-9]\d{3}\s*$/m.exec(text)
  const reject = /^للرفض:\s*رفض\s+CHG-(\d+)\s*$/m.exec(text)
  const reference = /^المرجع:\s*CHG-(\d+)\s*$/m.exec(text)
  return Boolean(approve && reject && reference &&
    approve[1] === reject[1] && reject[1] === reference[1])
}

export function isSensitiveOpenWAAdminOwnSentEcho(message: NormalizedInboundMessage): boolean {
  return message.provider === 'openwa' && message.type === 'text'
    && isSensitiveOpenWAAdminApprovalText(message.text?.body)
}
