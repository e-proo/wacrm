from pathlib import Path

route_path = Path('src/app/api/whatsapp/webhook/route.ts')
route = route_path.read_text()

marker = '/**\n * If an inbound message\'s sender is on a still-unreplied'
if marker not in route:
    raise SystemExit('OW-6 extraction marker not found')
head, block = route.split(marker, 1)
block = marker + block

# Shared processor owns all CRM/business fan-out after provider normalization.
block = block.replace('async function processMessage(\n  message: WhatsAppMessage,', 'export async function processNormalizedInboundMessage(\n  message: NormalizedInboundMessage,', 1)
block = block.replace('message_id: message.id,\n        status:', 'message_id: message.providerMessageId,\n        provider: message.provider,\n        connection_id: message.connectionId,\n        provider_message_id: message.providerMessageId,\n        status:', 1)

processor_imports = """import { createClient } from '@supabase/supabase-js'\nimport { getMediaUrl } from '@/lib/whatsapp/meta-api'\nimport { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'\nimport { normalizePhone } from '@/lib/whatsapp/phone-utils'\nimport { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'\nimport { reopenClosedConversation } from '@/lib/conversations/reopen'\nimport { runAutomationsForTrigger } from '@/lib/automations/engine'\nimport { dispatchInboundToFlows } from '@/lib/flows/engine'\nimport { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'\nimport {\n  dispatchInboundToAiAgent,\n  resolveTrustedAdminIdentity,\n  shouldRouteToMultiAgent,\n} from '@/lib/ai/runtime/dispatch'\nimport { dispatchWebhookEvent } from '@/lib/webhooks/deliver'\nimport { loadRuntimeRoutingSignals } from '@/lib/ai/runtime/routing-signals'\nimport { handleAdminChangeCommand } from '@/lib/ai/runtime/admin-change-commands'\nimport { engineSendText } from '@/lib/automations/meta-send'\nimport { correlateInboundTaskReply } from '@/lib/ai/tasks/reply-correlation'\nimport type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound-normalization'\n\nlet _adminClient: ReturnType<typeof createClient> | null = null\nfunction supabaseAdmin() {\n  if (!_adminClient) {\n    _adminClient = createClient(\n      process.env.NEXT_PUBLIC_SUPABASE_URL!,\n      process.env.SUPABASE_SERVICE_ROLE_KEY!,\n      { auth: { persistSession: false, autoRefreshToken: false } },\n    )\n  }\n  return _adminClient\n}\n\n"""
Path('src/lib/whatsapp/inbound-processor.ts').write_text(processor_imports + block)

# Rebuild the Meta route import section: Meta verification/status/template handling stays provider-specific;
# inbound CRM fan-out moves to the shared processor.
body_start = route.index('// The `after()` callback')
route_body = head[body_start:]
route_imports = """import { NextResponse, after } from 'next/server'\nimport { createClient } from '@supabase/supabase-js'\nimport { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'\nimport { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'\nimport { dispatchWebhookEvent } from '@/lib/webhooks/deliver'\nimport {\n  handleTemplateWebhookChange,\n  isTemplateWebhookField,\n} from '@/lib/whatsapp/template-webhook'\nimport { normalizeMetaInboundMessage } from '@/lib/whatsapp/inbound-normalization'\nimport { processNormalizedInboundMessage } from '@/lib/whatsapp/inbound-processor'\n\n"""
route = route_imports + route_body

# Resolve the provider-neutral Meta connection once per config and normalize before shared fan-out.
needle = """      const decryptedAccessToken = decrypt(config.access_token)\n\n      for (let i = 0; i < value.messages.length; i++) {"""
replacement = """      const decryptedAccessToken = decrypt(config.access_token)\n      const { data: metaConnection, error: metaConnectionError } = await supabaseAdmin()\n        .from('whatsapp_connections')\n        .select('id')\n        .eq('account_id', config.account_id)\n        .eq('provider', 'meta_cloud')\n        .maybeSingle()\n\n      if (metaConnectionError || !metaConnection?.id) {\n        console.error('[webhook] Meta provider-neutral connection not found:', metaConnectionError)\n        continue\n      }\n\n      for (let i = 0; i < value.messages.length; i++) {"""
if needle not in route:
    raise SystemExit('Meta connection insertion point not found')
route = route.replace(needle, replacement, 1)

old_call = """        await processMessage(\n          message,\n          contact,"""
new_call = """        const normalized = normalizeMetaInboundMessage(message, contact, metaConnection.id)\n        await processNormalizedInboundMessage(\n          normalized.message,\n          normalized.contact,"""
if old_call not in route:
    raise SystemExit('Meta processMessage call not found')
route = route.replace(old_call, new_call, 1)
route_path.write_text(route)

# Wire authenticated/deduplicated OpenWA intake into the same processor.
openwa_path = Path('src/app/api/whatsapp/openwa/webhook/route.ts')
openwa = openwa_path.read_text()
openwa = openwa.replace(
    "import { createClient } from '@supabase/supabase-js'\n",
    "import { createClient } from '@supabase/supabase-js'\n\nimport { normalizeOpenWAInboundMessage } from '@/lib/whatsapp/inbound-normalization'\nimport { processNormalizedInboundMessage } from '@/lib/whatsapp/inbound-processor'\n",
    1,
)
old_after = """  const { connectionId, envelope } = reservation\n  after(async () => {\n    try {\n      // OW-5 owns authenticated intake + durable dedup only. OW-6 will route\n      // accepted envelopes into the shared normalized inbound business path.\n      await markOpenWAWebhookProcessed(adminDb(), connectionId, envelope.eventId)"""
new_after = """  const { accountId, connectionId, envelope } = reservation\n  after(async () => {\n    try {\n      const db = adminDb()\n      const normalized = normalizeOpenWAInboundMessage(envelope, connectionId)\n      if (normalized) {\n        const { data: account, error: accountError } = await db\n          .from('accounts')\n          .select('owner_user_id')\n          .eq('id', accountId)\n          .maybeSingle()\n        if (accountError || !account?.owner_user_id) {\n          throw new Error('OpenWA account owner could not be resolved')\n        }\n\n        await processNormalizedInboundMessage(\n          normalized.message,\n          normalized.contact,\n          accountId,\n          connectionId,\n          account.owner_user_id,\n          '',\n          false,\n        )\n      }\n      await markOpenWAWebhookProcessed(db, connectionId, envelope.eventId)"""
if old_after not in openwa:
    raise SystemExit('OpenWA post-ack insertion point not found')
openwa = openwa.replace(old_after, new_after, 1)
openwa_path.write_text(openwa)
