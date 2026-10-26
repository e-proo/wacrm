from pathlib import Path

path = Path('src/app/api/whatsapp/webhook/route.ts')
text = path.read_text()
text = text.replace("import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'\n", "import { processMetaStatusEvent } from '@/lib/whatsapp/meta-status'\n")
text = text.replace("          await handleStatusUpdate(status)\n", "          await processMetaStatusEvent(supabaseAdmin(), value.metadata.phone_number_id, status)\n")
marker = "\n// The happy-path status ladder — pending → sent → delivered → read →\n"
if marker not in text:
    raise SystemExit('legacy status handler marker not found')
text = text.split(marker, 1)[0].rstrip() + "\n"
path.write_text(text)
