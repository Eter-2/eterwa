import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const h = vi.hoisted(() => ({
  processWebLead: vi.fn(),
  resolveWebLeadAccount: vi.fn(),
  after: vi.fn(),
}))

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: h.after }
})
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/meta/web-leads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/meta/web-leads')>()
  return {
    ...actual,
    processWebLead: h.processWebLead,
    resolveWebLeadAccount: h.resolveWebLeadAccount,
  }
})

import { POST } from './route'

const KEY = 'chave-de-teste-0123456789'

const BODY = {
  nome: 'Duarte Silva',
  telefone: '912345678',
  email: 'duarte@exemplo.pt',
  empresa: 'Plásticos do Norte',
  n_comerciais: '3-5',
  source: 'lp-vera-whatsapp',
  consentimento_whatsapp: true,
}

function req(body: unknown, headers: Record<string, string> = { 'x-lead-key': KEY }, raw = false) {
  return new Request('http://localhost/api/leads/web', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw ? (body as string) : JSON.stringify(body),
  })
}

beforeEach(() => {
  __resetRateLimitForTests()
  process.env.LEADS_WEB_KEY = KEY
  h.processWebLead.mockReset()
  h.resolveWebLeadAccount.mockReset()
  h.after.mockReset()
  h.resolveWebLeadAccount.mockResolvedValue({ accountId: 'acct-1', userId: 'user-1' })
  h.processWebLead.mockResolvedValue({ outcome: 'processed', webLeadId: 'wl-1', templateStatus: 'sent' })
})

afterEach(() => {
  delete process.env.LEADS_WEB_KEY
})

describe('POST /api/leads/web — autenticação', () => {
  it('503 quando LEADS_WEB_KEY não está definida (fail closed)', async () => {
    delete process.env.LEADS_WEB_KEY
    const res = await POST(req(BODY))
    expect(res.status).toBe(503)
    expect(h.processWebLead).not.toHaveBeenCalled()
  })

  it('401 sem chave', async () => {
    const res = await POST(req(BODY, {}))
    expect(res.status).toBe(401)
    expect(h.processWebLead).not.toHaveBeenCalled()
  })

  it('401 com chave errada (incluindo prefixo e comprimento diferente)', async () => {
    for (const k of ['errada', KEY.slice(0, -1), `${KEY}x`]) {
      const res = await POST(req(BODY, { 'x-lead-key': k }))
      expect(res.status).toBe(401)
    }
    expect(h.processWebLead).not.toHaveBeenCalled()
  })

  it('200 com a chave certa', async () => {
    const res = await POST(req(BODY))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'sent' })
  })
})

describe('POST /api/leads/web — validação', () => {
  it('400 com JSON inválido', async () => {
    const res = await POST(req('{nao-json', { 'x-lead-key': KEY }, true))
    expect(res.status).toBe(400)
  })

  it('400 sem consentimento_whatsapp, e a resposta não repete valores', async () => {
    const { consentimento_whatsapp: _c, ...rest } = BODY
    void _c
    const res = await POST(req(rest))
    expect(res.status).toBe(400)
    const body = JSON.stringify(await res.json())
    expect(body).toContain('consentimento_whatsapp')
    expect(body).not.toContain('duarte@exemplo.pt')
    expect(h.processWebLead).not.toHaveBeenCalled()
  })

  it('400 com source desconhecida ou email inválido', async () => {
    expect((await POST(req({ ...BODY, source: 'x' }))).status).toBe(400)
    expect((await POST(req({ ...BODY, email: 'x' }))).status).toBe(400)
  })

  it('413 com corpo grande demais', async () => {
    const res = await POST(req({ ...BODY, nome: 'a'.repeat(9000) }))
    expect(res.status).toBe(413)
  })
})

describe('POST /api/leads/web — comportamento', () => {
  it('passa o corpo validado a processWebLead e agenda o trabalho em background', async () => {
    const background = vi.fn()
    h.processWebLead.mockResolvedValue({ outcome: 'processed', templateStatus: 'sent', background })
    await POST(req(BODY))
    expect(h.processWebLead).toHaveBeenCalledWith(
      expect.anything(),
      { accountId: 'acct-1', userId: 'user-1' },
      expect.objectContaining({ nome: 'Duarte Silva', source: 'lp-vera-whatsapp' }),
    )
    expect(h.after).toHaveBeenCalledWith(background)
  })

  it('idempotente: duplicado devolve 200 {status: duplicate}', async () => {
    h.processWebLead.mockResolvedValue({ outcome: 'duplicate', webLeadId: 'wl-1' })
    const res = await POST(req(BODY))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'duplicate' })
  })

  it('sem consentimento: 200 com o estado skipped_no_consent', async () => {
    h.processWebLead.mockResolvedValue({
      outcome: 'processed',
      webLeadId: 'wl-1',
      templateStatus: 'skipped_no_consent',
    })
    const res = await POST(req({ ...BODY, consentimento_whatsapp: false }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'skipped_no_consent' })
  })

  it('telefone inválido: 422', async () => {
    h.processWebLead.mockResolvedValue({ outcome: 'invalid_phone', templateStatus: 'skipped_no_phone' })
    const res = await POST(req({ ...BODY, telefone: 'xx' }))
    expect(res.status).toBe(422)
  })

  it('503 quando não há conta resolvida', async () => {
    h.resolveWebLeadAccount.mockResolvedValue(null)
    expect((await POST(req(BODY))).status).toBe(503)
  })

  it('500 sem detalhes quando processWebLead lança', async () => {
    h.processWebLead.mockRejectedValue(new Error('segredo interno da BD'))
    const res = await POST(req(BODY))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('segredo')
  })

  it('429 depois de 10 pedidos do mesmo IP no minuto', async () => {
    const headers = { 'x-lead-key': KEY, 'x-forwarded-for': '203.0.113.9' }
    let last = 200
    for (let i = 0; i < 11; i++) last = (await POST(req(BODY, headers))).status
    expect(last).toBe(429)
    // Outro IP continua a passar.
    expect((await POST(req(BODY, { ...headers, 'x-forwarded-for': '203.0.113.10' }))).status).toBe(200)
  })

  it('pedidos sem chave não gastam o orçamento de rate limit', async () => {
    for (let i = 0; i < 30; i++) await POST(req(BODY, { 'x-forwarded-for': '203.0.113.9' }))
    const ok = await POST(req(BODY, { 'x-lead-key': KEY, 'x-forwarded-for': '203.0.113.9' }))
    expect(ok.status).toBe(200)
  })
})
