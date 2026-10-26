import fs from 'node:fs'

const path = 'src/lib/whatsapp/inbound-processor.ts'
let source = fs.readFileSync(path, 'utf8')
const importAnchor = "import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'\n"
if (!source.includes("mirrorOpenWAInboundMedia")) {
  source = source.replace(importAnchor, importAnchor + "import { mirrorOpenWAInboundMedia } from '@/lib/whatsapp/transport/openwa/inbound-media'\n")
}
const tryAnchor = `  ): Promise<string | null> => {\n    try {\n      const info = await getMediaUrl({ mediaId, accessToken })`
const replacement = `  ): Promise<string | null> => {\n    if (message.provider === 'openwa') {\n      if (!mirror) return null\n      const media = message.type === 'image' ? message.image : message.type === 'video' ? message.video : message.type === 'document' ? message.document : message.type === 'audio' ? message.audio : null\n      if (!media || !['image', 'video', 'document', 'audio'].includes(message.type)) return null\n      try {\n        return await mirrorOpenWAInboundMedia({\n          db: supabaseAdmin(),\n          storage: supabaseAdmin().storage,\n          accountId: mirror.accountId,\n          connectionId: message.connectionId,\n          kind: message.type as 'image' | 'video' | 'document' | 'audio',\n          media,\n          messageTimestamp: message.timestamp,\n        })\n      } catch (error) {\n        console.error('[openwa-media] inbound mirror failed', { connectionId: message.connectionId, mediaId })\n        return null\n      }\n    }\n    try {\n      const info = await getMediaUrl({ mediaId, accessToken })`
if (!source.includes("[openwa-media] inbound mirror failed")) {
  if (!source.includes(tryAnchor)) throw new Error('OW-8 parse anchor not found')
  source = source.replace(tryAnchor, replacement)
}
fs.writeFileSync(path, source)

const routePath = 'src/app/api/whatsapp/openwa/webhook/route.ts'
let route = fs.readFileSync(routePath, 'utf8')
const routeAnchor = `          '',\n          false,\n        )`
if (route.includes(routeAnchor)) route = route.replace(routeAnchor, `          '',\n          true,\n        )`)
fs.writeFileSync(routePath, route)
