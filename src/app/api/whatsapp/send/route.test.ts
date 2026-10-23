import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const conversationInserts: Array<Record<string, unknown>> = []
const messageInserts: Array<Record<string, unknown>> = []
let existingConversation: Record<string, unknown> | null = null
let contactRow: Record<string, unknown> | null = null
let callerRole: string = 'admin'
let createdConversation: Record<string, unknown> | null = null

const CONTACT = {
  id: 'contact-1',
  account_id: 'acct-1',
  phone: '+15551234567',
}

function makeSupabaseMock() {
  function builder(table: string) {
    let didInsert = false
    const selectResult = () => {
      switch (table) {
        case 'profiles':
          return { data: { account_id: 'acct-1', account_role: callerRole }, error: null }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'Acme' }, error: null }
        case 'contacts':
          return { data: contactRow, error: null }
        case 'conversations':
          return { data: createdConversation ?? existingConversation, error: null }
        case 'whatsapp_connections':
          return {
            data: {
              id: 'conn-meta-1',
              account_id: 'acct-1',
              provider: 'meta_cloud',
              provider_external_id: 'PNID-1',
            },
            error: null,
          }
        case 'whatsapp_config':
          return {
            data: {
              id: 'cfg-1',
              account_id: 'acct-1',
              phone_number_id: 'PNID-1',
              access_token: 'enc-token',
            },
            error: null,
          }
        case 'message_templates':
          return { data: null, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const insertResult = () => {
      switch (table) {
        case 'conversations':
          return {
            data: {
              id: 'conv-new',
              account_id: 'acct-1',
              contact_id: 'contact-1',
              contact: CONTACT,
            },
            error: null,
          }
        case 'messages':
          return { data: { id: 'msg-1' }, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const terminal = () => Promise.resolve(didInsert ? insertResult() : selectResult())
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'delete']) b[m] = vi.fn(chain)
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true
      if (table === 'conversations') {
        conversationInserts.push(payload)
        createdConversation = {
          id: 'conv-new',
          account_id: 'acct-1',
          contact_id: 'contact-1',
          contact: CONTACT,
        }
      }
      if (table === 'messages') messageInserts.push(payload)
      return b
    })
    b.single = vi.fn(terminal)
    b.maybeSingle = vi.fn(terminal)
    b.then = (resolve: (v: unknown) => unknown) => resolve(didInsert ? insertResult() : selectResult())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => supabaseMock) }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['update', 'eq', 'select']) b[m] = vi.fn(chain)
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}))

const { sendTemplateMessage } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage,
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}))

import { POST } from './route'

function postContactTemplate(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: 'contact-1',
        message_type: 'template',
        template_name: 'order_update',
        template_language: 'en_US',
        template_message_params: { body: ['Acme', '#1234'] },
        template_params: ['Acme', '#1234'],
        ...overrides,
      }),
    }),
  )
}

describe('POST /api/whatsapp/send — contact_id template path', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    existingConversation = null
    createdConversation = null
    contactRow = CONTACT
    callerRole = 'admin'
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })
  afterEach(() => vi.clearAllMocks())

  it('creates a conversation for a contact with none, then sends the template', async () => {
    const res = await postContactTemplate()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.whatsapp_message_id).toBe('wamid-1')
    expect(conversationInserts).toHaveLength(1)
    expect(conversationInserts[0]).toMatchObject({ account_id: 'acct-1', contact_id: 'contact-1' })
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    const args = (sendTemplateMessage.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(args.to).toBe('15551234567')
    expect(args.templateName).toBe('order_update')
    expect(messageInserts).toHaveLength(1)
    expect(messageInserts[0]).toMatchObject({
      conversation_id: 'conv-new',
      content_type: 'template',
      template_name: 'order_update',
      sender_type: 'agent',
      provider: 'meta_cloud',
      connection_id: 'conn-meta-1',
      provider_message_id: 'wamid-1',
    })
  })

  it('reuses an existing conversation instead of creating a duplicate', async () => {
    existingConversation = {
      id: 'conv-existing', account_id: 'acct-1', contact_id: 'contact-1', contact: CONTACT,
    }
    const res = await postContactTemplate()
    expect(res.status).toBe(200)
    expect(conversationInserts).toHaveLength(0)
    expect(messageInserts[0]).toMatchObject({ conversation_id: 'conv-existing' })
  })

  it('404s when the contact is not in the caller account', async () => {
    contactRow = null
    const res = await postContactTemplate()
    const json = await res.json()
    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('400s when neither conversation_id nor contact_id is provided', async () => {
    const res = await POST(new Request('http://localhost/api/whatsapp/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_type: 'template', template_name: 'x' }),
    }))
    expect(res.status).toBe(400)
  })
})

describe('POST /api/whatsapp/send — role enforcement', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    existingConversation = {
      id: 'conv-existing', account_id: 'acct-1', contact_id: 'contact-1', contact: CONTACT,
    }
    createdConversation = null
    contactRow = CONTACT
    callerRole = 'admin'
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })
  afterEach(() => vi.clearAllMocks())

  it('refuses a viewer with 403 and never reaches Meta', async () => {
    callerRole = 'viewer'
    const res = await postContactTemplate()
    expect(res.status).toBe(403)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(messageInserts).toHaveLength(0)
  })

  it('allows an agent through', async () => {
    callerRole = 'agent'
    const res = await postContactTemplate()
    expect(res.status).toBe(200)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
  })
})
