from pathlib import Path

route_test = Path('src/app/api/whatsapp/webhook/route.test.ts')
s = route_test.read_text()
needle = "        case 'trusted_admin_identities':\n"
insert = """        case 'whatsapp_connections':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: { id: 'meta-connection-1' },
                      error: null,
                    }),
                }),
              }),
            }),
          }
"""
if insert not in s:
    if needle not in s:
        raise SystemExit('route test insertion point not found')
    s = s.replace(needle, insert + needle, 1)
route_test.write_text(s)

reply_test = Path('src/lib/ai/tasks/reply-correlation.test.ts')
s = reply_test.read_text()
s = s.replace("new URL('../../../app/api/whatsapp/webhook/route.ts', import.meta.url)", "new URL('../../whatsapp/inbound-processor.ts', import.meta.url)")
s = s.replace("keeps trusted-admin routing before task correlation in the webhook", "keeps trusted-admin routing before task correlation in the shared inbound processor")
reply_test.write_text(s)
