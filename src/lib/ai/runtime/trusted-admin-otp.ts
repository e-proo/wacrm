import { supabaseAdmin } from '../admin-client'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  isRecipientNotAllowedError,
  phoneVariants,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils'

/** Deliver the one-time code to the phone being verified. Never logs/returns it. */
export async function sendTrustedAdminOtp(args: {
  accountId: string
  normalizedAddress: string
  otp: string
}): Promise<void> {
  const db = supabaseAdmin()
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', args.accountId)
    .single()
  if (error || !config) throw new Error('WhatsApp not configured for this account')

  const phone = sanitizePhoneForMeta(args.normalizedAddress)
  const accessToken = decrypt(config.access_token)
  const text = `رمز التحقق الإداري في WACRM: ${args.otp}\nينتهي خلال 10 دقائق. لا تشارك هذا الرمز مع أي شخص.`

  let lastError: unknown = null
  for (const candidate of phoneVariants(phone)) {
    try {
      await sendTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: candidate,
        text,
      })
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(message)) throw err
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not deliver verification code')
}
