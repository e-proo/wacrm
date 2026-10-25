from pathlib import Path

path = Path('src/lib/whatsapp/inbound-processor.ts')
text = path.read_text()
text = text.replace('WhatsAppMessage', 'NormalizedInboundMessage')
text = text.replace('Resolve a Meta-side message_id', 'Resolve a provider message id')
text = text.replace('ack 200 to Meta.', 'acknowledgement path.')
path.write_text(text.rstrip() + '\n')
