import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: vi.fn() }))
vi.mock('@/lib/eter/followups', () => ({ scheduleAdLeadCadence: vi.fn() }))

import {
  DEFAULT_COMMERCIAL_WELCOME_MESSAGE,
  DEFAULT_COMMERCIAL_FALLBACK_MESSAGE,
  hasRecentCommercialFallback,
} from './commercial'

// ============================================================
// Abertura única (Ricardo, 29/09/2026) e limite do fallback. O
// comportamento de dispatch (sem IA no 1.º turno, cadência) está em
// auto-reply.test.ts.
// ============================================================

describe('DEFAULT_COMMERCIAL_WELCOME_MESSAGE', () => {
  it('é exactamente o texto fixo aprovado, sem pergunta de cargo', () => {
    expect(DEFAULT_COMMERCIAL_WELCOME_MESSAGE).toBe(
      'Olá! Sou o agente de IA da Eter Growth, é exactamente isto que pomos a funcionar nas empresas: resposta em segundos, a qualquer hora. Conte-me em uma frase o que faz a sua empresa e mostro-lhe como ficaria no seu caso.',
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
