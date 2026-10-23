import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

function noDb(): SupabaseClient {
  return { from() { throw new Error('db should not be queried for invalid params'); } } as unknown as SupabaseClient;
}

async function expectSendError(params: SendMessageParams, status: number, messageMatch?: RegExp) {
  await expect(sendMessageToConversation(noDb(), 'acct-1', params)).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch((e: SendMessageError) => {
    expect(e.status).toBe(status);
    if (messageMatch) expect(e.message).toMatch(messageMatch);
  });
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };
  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });
  it('rejects an unsupported message_type', async () => {
    await expectSendError({ ...base, messageType: 'carrier-pigeon' }, 400, /Unsupported message_type/);
  });
  it('requires content_text for text messages', async () => {
    await expectSendError({ ...base, messageType: 'text' }, 400, /content_text is required/);
  });
  it('requires template_name for template messages', async () => {
    await expectSendError({ ...base, messageType: 'template' }, 400, /template_name is required/);
  });
  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError({ ...base, messageType: kind }, 400, /media_url is required/);
    }
  });
  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError({ ...base, messageType: 'image', mediaUrl: 'https://x/y.jpg', contentText: 'a'.repeat(1025) }, 400, /1024-character limit/);
  });
  it('requires a valid interactive payload for interactive messages', async () => {
    await expectSendError({ ...base, messageType: 'interactive' }, 400, /payload is required/);
    await expectSendError({
      ...base,
      messageType: 'interactive',
      interactivePayload: {
        kind: 'buttons', body: 'Pick one',
        buttons: [
          { id: 'a', title: 'A' }, { id: 'b', title: 'B' },
          { id: 'c', title: 'C' }, { id: 'd', title: 'D' },
        ],
      },
    }, 400, /at most 3 buttons/);
    await expectSendError({
      ...base,
      messageType: 'interactive',
      interactivePayload: { kind: 'buttons', body: 'Pick one', buttons: [{ id: 'a', title: 'x'.repeat(21) }] },
    }, 400, /20-character limit/);
  });
  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    const spy = vi.fn(() => { throw new Error('reached DB'); });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(sendMessageToConversation(db, 'acct-1', {
      ...base, messageType: 'audio', mediaUrl: 'https://x/y.ogg', contentText: 'a'.repeat(2000),
    })).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.1' }));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.text' })),
  sendTemplateMessage: (...args: unknown[]) =>
    (sendTemplateMessage as unknown as (...a: unknown[]) => unknown)(...args),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.media' })),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'wamid.btn' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'wamid.list' })),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) }),
  }),
}));

interface CapturedWrites {
  message?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
}

function sendPathDb(templateRows: unknown[], captured: CapturedWrites): SupabaseClient {
  const conversation = { id: 'cv-1', account_id: 'acct-1', contact: { id: 'ct-1', account_id: 'acct-1', phone: '+15551234567' } };
  const config = { id: 'cfg-1', account_id: 'acct-1', phone_number_id: 'pn-1', access_token: 'token' };
  const connection = { id: 'conn-meta-1', account_id: 'acct-1', provider: 'meta_cloud', provider_external_id: 'pn-1' };

  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: (row: Record<string, unknown>) => {
          if (table === 'messages') captured.message = row;
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'conversations') captured.conversation = row;
          return builder;
        },
        maybeSingle: async () => {
          if (table === 'whatsapp_connections') return { data: connection, error: null };
          if (table === 'whatsapp_config') return { data: config, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'conversations') return { data: conversation, error: null };
          if (table === 'messages') return { data: { id: 'msg-1' }, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: table === 'message_templates' ? templateRows : [], error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const TEMPLATE_ROW = {
  id: 'tpl-1', user_id: 'u-1', name: 'order_update', category: 'Utility', language: 'en',
  body_text: 'Your order {{1}} ships on {{2}}', created_at: '2026-01-01T00:00:00Z',
};

describe('sendMessageToConversation — template persistence (#483)', () => {
  it('stores the substituted body when the caller sends no text', async () => {
    const captured: CapturedWrites = {};
    const result = await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1', messageType: 'template', templateName: 'order_update', templateParams: ['A123', 'Friday'],
    });
    expect(result.whatsappMessageId).toBe('wamid.1');
    expect(captured.message?.content_text).toBe('Your order A123 ships on Friday');
    expect(captured.message).toMatchObject({
      message_id: 'wamid.1', provider: 'meta_cloud', connection_id: 'conn-meta-1', provider_message_id: 'wamid.1',
    });
    expect(captured.message?.template_name).toBe('order_update');
    expect(captured.conversation?.last_message_text).toBe('Your order A123 ships on Friday');
  });

  it('reads body values out of the structured params shape too', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1', messageType: 'template', templateName: 'order_update',
      templateMessageParams: { body: ['B456', 'Monday'] },
    });
    expect(captured.message?.content_text).toBe('Your order B456 ships on Monday');
  });

  it("does not override the composer's pre-rendered text", async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1', messageType: 'template', templateName: 'order_update',
      templateParams: ['A123', 'Friday'], contentText: 'rendered by the composer',
    });
    expect(captured.message?.content_text).toBe('rendered by the composer');
  });

  it("sends the local row's language when the caller names none", async () => {
    sendTemplateMessage.mockClear();
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([TEMPLATE_ROW], captured), 'acct-1', {
      conversationId: 'cv-1', messageType: 'template', templateName: 'order_update', templateParams: ['A123', 'Friday'],
    });
    expect((sendTemplateMessage.mock.calls[0] as unknown as [{ language: string }])[0].language).toBe('en');
  });

  it('leaves content_text null when the account has no local template row', async () => {
    const captured: CapturedWrites = {};
    await sendMessageToConversation(sendPathDb([], captured), 'acct-1', {
      conversationId: 'cv-1', messageType: 'template', templateName: 'never_synced', templateParams: ['A123'],
    });
    expect(captured.message?.content_text).toBeNull();
    expect(captured.conversation?.last_message_text).toBe('[template]');
  });
});
