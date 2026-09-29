import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: vi.fn() }))
vi.mock('@/lib/eter/followups', () => ({ scheduleAdLeadCadence: vi.fn() }))

import {
  DEFAULT_COMMERCIAL_WELCOME_MESSAGE,
  DEFAULT_COMMERCIAL_FALLBACK_MESSAGE,
  hasRecentCommercialFallback,
  hasOutboundMessage,
  sendCommercialWelcomeIfNeeded,
} from './commercial'
import { engineSendText } from '@/lib/flows/meta-send'

// ============================================================
// Abertura única (Ricardo, 29/09/2026) e limite do fallback. O
// comportamento de dispatch (sem IA no 1.º turno, cadência) está em
// auto-reply.test.ts.
// ============================================================

describe('DEFAULT_COMMERCIAL_WELCOME_MESSAGE', () => {
  it('é exactamente o texto fixo aprovado, sem pergunta de cargo', () => {
    expect(DEFAULT_COMMERCIAL_WELCOME_MESSAGE).toBe(
      'Olá! Sou a Vera, da Eter Growth. Com quem estou a falar?',
    )
    expect(DEFAULT_COMMERCIAL_WELCOME_MESSAGE).not.toContain('\u2014')
  })
})

function dbReturning(result: { data: unknown; error: { message: string } | null }) {
  const calls: { method: string; args: unknown[] }[] = []
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'gte']) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args })
      return chain
    }
  }
  chain.limit = (...args: unknown[]) => {
    calls.push({ method: 'limit', args })
    return Promise.resolve(result)
  }
  return { db: { from: () => chain } as unknown as SupabaseClient, calls }
}

describe('hasRecentCommercialFallback', () => {
  it('true quando há um fallback nas últimas 24h; a janela e o texto vêm no filtro', async () => {
    const { db, calls } = dbReturning({ data: [{ id: 'm1' }], error: null })
    const now = new Date('2026-09-29T12:00:00.000Z')
    await expect(hasRecentCommercialFallback(db, 'conv-1', now)).resolves.toBe(true)
    expect(calls).toContainEqual({
      method: 'gte',
      args: ['created_at', '2026-09-28T12:00:00.000Z'],
    })
    expect(calls).toContainEqual({
      method: 'eq',
      args: ['content_text', DEFAULT_COMMERCIAL_FALLBACK_MESSAGE],
    })
  })

  it('false quando não há nenhum', async () => {
    const { db } = dbReturning({ data: [], error: null })
    await expect(hasRecentCommercialFallback(db, 'conv-1')).resolves.toBe(false)
  })

  it('erro de leitura conta como "não saiu" (regista e deixa passar)', async () => {
    const { db } = dbReturning({ data: null, error: { message: 'boom' } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(hasRecentCommercialFallback(db, 'conv-1')).resolves.toBe(false)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('hasOutboundMessage', () => {
  function db(result: { data: unknown; error: { message: string } | null }) {
    const calls: { method: string; args: unknown[] }[] = []
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in']) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ method: m, args })
        return chain
      }
    }
    chain.limit = () => Promise.resolve(result)
    return { db: { from: () => chain } as unknown as SupabaseClient, calls }
  }

  it('true quando existe mensagem agent/bot na conversa', async () => {
    const { db: d, calls } = db({ data: [{ id: 'm1' }], error: null })
    await expect(hasOutboundMessage(d, 'conv-1')).resolves.toBe(true)
    expect(calls).toContainEqual({ method: 'in', args: ['sender_type', ['agent', 'bot']] })
  })
  it('false sem mensagens e em erro de leitura', async () => {
    await expect(hasOutboundMessage(db({ data: [], error: null }).db, 'c')).resolves.toBe(false)
    await expect(
      hasOutboundMessage(db({ data: null, error: { message: 'x' } }).db, 'c'),
    ).resolves.toBe(false)
  })
})

describe('sendCommercialWelcomeIfNeeded com outbound anterior (template)', () => {
  it('não envia a abertura, marca-a como enviada e devolve false', async () => {
    vi.mocked(engineSendText).mockClear()
    const updates: unknown[] = []
    const upd: Record<string, unknown> = {
      eq: () => upd,
      is: () => Promise.resolve({ error: null }),
    }
    const sel: Record<string, unknown> = {
      select: () => sel,
      eq: () => sel,
      in: () => sel,
      limit: () => Promise.resolve({ data: [{ id: 'tpl-1' }], error: null }),
    }
    const d = {
      from: (t: string) =>
        t === 'messages'
          ? sel
          : { update: (p: unknown) => (updates.push(p), upd) },
    } as unknown as SupabaseClient
    const sent = await sendCommercialWelcomeIfNeeded({
      db: d,
      accountId: 'a',
      conversationId: 'c',
      contactId: 'ct',
      configOwnerUserId: 'u',
      welcomeMessage: null,
      source: 'direct',
    })
    expect(sent).toBe(false)
    expect(engineSendText).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
  })
})
