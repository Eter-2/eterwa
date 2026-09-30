import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/meta-api', async () => {
  const actual = await vi.importActual<typeof import('./meta-api')>('./meta-api');
  return {
    ...actual,
    sendTextMessage: vi.fn(() => Promise.resolve({ messageId: 'wamid.123' })),
    sendTemplateMessage: vi.fn(),
    sendMediaMessage: vi.fn(),
    sendInteractiveButtons: vi.fn(),
    sendInteractiveList: vi.fn(),
  };
});
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plain-access-token'),
  encrypt: vi.fn((v: string) => `enc:${v}`),
  isLegacyFormat: vi.fn(() => false),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: vi.fn(() => ({
    from: () => ({
      update: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }),
      }),
    }),
  })),
}));

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('requires a valid interactive payload for interactive messages', async () => {
    // Missing payload entirely.
    await expectSendError(
      { ...base, messageType: 'interactive' },
      400,
      /payload is required/
    );
    // Too many buttons.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
      400,
      /at most 3 buttons/
    );
    // Over-long button title.
    await expectSendError(
      {
        ...base,
        messageType: 'interactive',
        interactivePayload: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'a', title: 'x'.repeat(21) }],
        },
      },
      400,
      /20-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

// ============================================================
// Bloco 3-A / migração 051 (Ricardo, 21/09/2026, correcção 3) — um
// envio humano pelo dashboard/API pública (sempre `sender_type =
// 'agent'`) desliga `ai_autoreply_disabled`. É o ÚNICO momento em que
// isto acontece agora — chamar a equipa (handoff) já não desliga o
// auto-reply, ver src/lib/ai/auto-reply.test.ts.
// ============================================================
describe('sendMessageToConversation — happy path desliga o auto-reply (correcção 3)', () => {
  function makeHappyDb() {
    const conversationsUpdates: Record<string, unknown>[] = [];
    const db = {
      from(table: string) {
        if (table === 'conversations') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: () =>
                    Promise.resolve({
                      data: {
                        id: 'cv-1',
                        contact: { id: 'contact-1', phone: '+351911111111' },
                      },
                      error: null,
                    }),
                }),
              }),
            }),
            update: (payload: Record<string, unknown>) => {
              conversationsUpdates.push(payload);
              return { eq: () => Promise.resolve({ error: null }) };
            },
          };
        }
        if (table === 'whatsapp_config') {
          return {
            select: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: {
                      id: 'wc-1',
                      phone_number_id: 'pn-1',
                      access_token: 'enc:token',
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === 'messages') {
          return {
            insert: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id: 'msg-1' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'contacts') {
          return {
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient;
    return { db, conversationsUpdates };
  }

  it('desliga ai_autoreply_disabled depois de um envio humano bem-sucedido', async () => {
    const { db, conversationsUpdates } = makeHappyDb();

    const result = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'Olá, aqui é o Ricardo.',
    });

    expect(result.messageId).toBe('msg-1');
    expect(conversationsUpdates).toContainEqual({ ai_autoreply_disabled: true });
  });
});

describe('sendMessageToConversation — templates gravam o texto renderizado', () => {
  const BODY = 'Olá {{1}}, sou a Vera. Quer retomar a conversa na {{2}}?';

  function makeDb(templateRow: Record<string, unknown> | null) {
    const inserted: Record<string, unknown>[] = [];
    const convUpdates: Record<string, unknown>[] = [];
    const db = {
      from(table: string) {
        if (table === 'conversations') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: () =>
                    Promise.resolve({
                      data: { id: 'cv-1', contact: { id: 'c-1', phone: '+351911111111' } },
                      error: null,
                    }),
                }),
              }),
            }),
            update: (p: Record<string, unknown>) => {
              convUpdates.push(p);
              return { eq: () => ({ is: () => Promise.resolve({ error: null }), then: (r: (v: unknown) => void) => r({ error: null }) }) };
            },
          };
        }
        if (table === 'whatsapp_config') {
          return {
            select: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: { id: 'wc-1', phone_number_id: 'pn', access_token: 'enc:t', waba_id: 'w', user_id: 'u-1' },
                    error: null,
                  }),
              }),
            }),
          };
        }
        if (table === 'message_templates') {
          return {
            select: () => {
              const q: Record<string, unknown> = {};
              q.eq = () => q;
              q.maybeSingle = () => Promise.resolve({ data: templateRow, error: null });
              return q;
            },
            insert: (row: Record<string, unknown>) => ({
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { ...row, id: 'tpl-new', created_at: 'x' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'messages') {
          return {
            insert: (row: Record<string, unknown>) => {
              inserted.push(row);
              return { select: () => ({ single: () => Promise.resolve({ data: { id: 'msg-1' }, error: null }) }) };
            },
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient;
    return { db, inserted, convUpdates };
  }

  beforeEach(async () => {
    const meta = await import('@/lib/whatsapp/meta-api');
    vi.mocked(meta.sendTemplateMessage).mockResolvedValue({ messageId: 'wamid.tpl' });
  });

  it('renderiza o corpo do template local com os params e actualiza a pré-visualização', async () => {
    const { db, inserted, convUpdates } = makeDb({
      id: 'tpl-1', user_id: 'u-1', name: 'v2', language: 'pt_PT', body_text: BODY,
    });
    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'v2',
      templateLanguage: 'pt_PT',
      templateMessageParams: { body: ['Bruno', 'Magnusberry'] },
    });
    const expected = 'Olá Bruno, sou a Vera. Quer retomar a conversa na Magnusberry?';
    expect(inserted[0].content_text).toBe(expected);
    expect(convUpdates).toContainEqual(expect.objectContaining({ last_message_text: expected }));
  });

  it('sem linha local vai buscar o corpo à Graph API', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [{
        id: '1', name: 'v2', language: 'pt_PT', status: 'APPROVED', category: 'MARKETING',
        components: [{ type: 'BODY', text: BODY }],
      }] }), { status: 200 })),
    ) as unknown as typeof fetch;
    try {
      const { db, inserted } = makeDb(null);
      await sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'v2',
        templateLanguage: 'pt_PT',
        templateParams: ['Ana', 'Acme'],
      });
      expect(inserted[0].content_text).toBe('Olá Ana, sou a Vera. Quer retomar a conversa na Acme?');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('se tudo falhar grava o fallback [template: nome]', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))) as unknown as typeof fetch;
    try {
      const { db, inserted } = makeDb(null);
      await sendMessageToConversation(db, 'acct-1', {
        conversationId: 'cv-1',
        messageType: 'template',
        templateName: 'v2',
        templateLanguage: 'pt_PT',
      });
      expect(inserted[0].content_text).toBe('[template: v2]');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('respeita o content_text enviado pelo Inbox', async () => {
    const { db, inserted } = makeDb({ id: 't', user_id: 'u', name: 'v2', language: 'pt_PT', body_text: BODY });
    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'v2',
      templateLanguage: 'pt_PT',
      contentText: 'texto já renderizado',
    });
    expect(inserted[0].content_text).toBe('texto já renderizado');
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
