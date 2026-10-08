import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb, type FakeDb } from './fake-db.test-util'

const engineSendTemplateMock = vi.fn()
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendTemplate: (...args: unknown[]) => engineSendTemplateMock(...args),
}))
const crmSyncMock = vi.fn()
vi.mock('@/lib/crm/sync', () => ({
  syncMetaAdLeadToCrm: (...args: unknown[]) => crmSyncMock(...args),
  syncMetaLeadToCrm: (...args: unknown[]) => crmSyncMock(...args),
}))
const notifyDemoLeadMock = vi.fn().mockResolvedValue({ mattermost: { sent: true, via: 'webhook' }, whatsapp: [] })
const notifyCapWarningMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/notifications/notify-team', () => ({
  notifyDemoLead: (...args: unknown[]) => notifyDemoLeadMock(...args),
  notifyDemoCapWarning: (...args: unknown[]) => notifyCapWarningMock(...args),
}))

import {
  RETRY_MAX_ATTEMPTS,
  WEB_LEAD_DAILY_CAP,
  normalizeWebPhone,
  processWebLead,
  resolveWebLeadAccount,
  retryPendingWebLeads,
  webLeadSchema,
  type WebLeadInput,
} from './web-leads'

const ACCOUNT = { accountId: 'acct-1', userId: 'user-1' }

const INPUT: WebLeadInput = {
  nome: 'Duarte Silva',
  telefone: '912 345 678',
  email: 'duarte@exemplo.pt',
  empresa: 'Plásticos do Norte',
  n_comerciais: '3-5',
  source: 'lp-vera-whatsapp',
  consentimento_whatsapp: true,
  consentimento_texto: 'Aceito ser contactado por WhatsApp sobre a demonstração da Vera.',
  pagina_url: 'https://etergrowth.com/agente-whatsapp',
  user_agent: 'Mozilla/5.0 (teste)',
  ip_visitante: '203.0.113.7',
  utm: { utm_source: 'linkedin' },
}

let db: FakeDb

beforeEach(() => {
  db = makeFakeDb({
    whatsapp_config: [{ id: 'cfg-1', account_id: 'acct-1', user_id: 'user-1' }],
  })
  engineSendTemplateMock.mockReset()
  engineSendTemplateMock.mockResolvedValue({ whatsapp_message_id: 'wamid.1' })
  notifyDemoLeadMock.mockClear()
  notifyCapWarningMock.mockClear()
  crmSyncMock.mockClear()
})

describe('normalizeWebPhone', () => {
  it('acrescenta 351 a números portugueses de 9 dígitos', () => {
    expect(normalizeWebPhone('912 345 678')).toBe('351912345678')
    expect(normalizeWebPhone('234 567 890')).toBe('351234567890')
  })
  it('aceita +351 e 00351', () => {
    expect(normalizeWebPhone('+351 912 345 678')).toBe('351912345678')
    expect(normalizeWebPhone('00351912345678')).toBe('351912345678')
  })
  it('mantém números internacionais válidos', () => {
    expect(normalizeWebPhone('+49 151 23456789')).toBe('4915123456789')
    expect(normalizeWebPhone('+34 612 345 678')).toBe('34612345678')
  })
  it('rejeita números portugueses impossíveis (prefixo ou comprimento)', () => {
    expect(normalizeWebPhone('999 999 999')).toBeNull()
    expect(normalizeWebPhone('+351 112345678')).toBeNull()
    expect(normalizeWebPhone('91234567')).toBeNull()
    expect(normalizeWebPhone('+351 9123456789')).toBeNull()
  })
  it('rejeita lixo, curtos e longos demais', () => {
    expect(normalizeWebPhone('abc')).toBeNull()
    expect(normalizeWebPhone('12345')).toBeNull()
    expect(normalizeWebPhone('1234567890123456')).toBeNull()
  })
})

describe('webLeadSchema', () => {
  it('aceita o corpo do contrato', () => {
    expect(webLeadSchema.safeParse(INPUT).success).toBe(true)
  })
  it('exige consentimento_whatsapp presente', () => {
    const { consentimento_whatsapp: _c, ...rest } = INPUT
    void _c
    expect(webLeadSchema.safeParse(rest).success).toBe(false)
  })
  it('rejeita source desconhecida, email inválido e nome vazio', () => {
    expect(webLeadSchema.safeParse({ ...INPUT, source: 'outra' }).success).toBe(false)
    expect(webLeadSchema.safeParse({ ...INPUT, email: 'nao-e-email' }).success).toBe(false)
    expect(webLeadSchema.safeParse({ ...INPUT, nome: '  ' }).success).toBe(false)
  })
  it('limita o utm', () => {
    const utm = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']))
    expect(webLeadSchema.safeParse({ ...INPUT, utm }).success).toBe(false)
  })
})

describe('resolveWebLeadAccount', () => {
  it('usa a única whatsapp_config', async () => {
    expect(await resolveWebLeadAccount(db.client, undefined)).toEqual(ACCOUNT)
  })
  it('recusa quando há várias configs e nenhuma conta fixada', async () => {
    db.tables.whatsapp_config.push({ id: 'cfg-2', account_id: 'acct-2', user_id: 'user-2' })
    expect(await resolveWebLeadAccount(db.client, undefined)).toBeNull()
  })
  it('respeita LEADS_WEB_ACCOUNT_ID', async () => {
    db.tables.whatsapp_config.push({ id: 'cfg-2', account_id: 'acct-2', user_id: 'user-2' })
    expect(await resolveWebLeadAccount(db.client, 'acct-2')).toEqual({
      accountId: 'acct-2',
      userId: 'user-2',
    })
  })
})

describe('processWebLead', () => {
  it('cria contacto + conversa site_demo e envia o template com o primeiro nome', async () => {
    const result = await processWebLead(db.client, ACCOUNT, INPUT)

    expect(result.outcome).toBe('processed')
    expect(result.templateStatus).toBe('sent')

    const [contact] = db.tables.contacts
    expect(contact).toMatchObject({ phone: '351912345678', name: 'Duarte Silva', company: 'Plásticos do Norte' })

    const [conv] = db.tables.conversations
    expect(conv.source).toBe('site_demo')
    expect(conv.demo_context).toMatchObject({
      origem: 'lp-vera-whatsapp',
      empresa: 'Plásticos do Norte',
      n_comerciais: '3-5',
    })
    expect(String(conv.escalation_reason)).toContain('lp-vera-whatsapp')

    expect(engineSendTemplateMock).toHaveBeenCalledTimes(1)
    expect(engineSendTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'eter_demo_web_v1',
        language: 'pt_PT',
        params: ['Duarte'],
        accountId: 'acct-1',
        contactId: contact.id,
        conversationId: conv.id,
      }),
    )

    const [lead] = db.tables.web_leads
    expect(lead).toMatchObject({
      template_status: 'sent',
      template_message_id: 'wamid.1',
      consent_text: INPUT.consentimento_texto,
      consent_url: INPUT.pagina_url,
      consent_user_agent: INPUT.user_agent,
      consent_visitor_ip: '203.0.113.7',
      telefone: '351912345678',
      contact_id: contact.id,
      conversation_id: conv.id,
    })

    // O aviso à equipa corre em background; o EterWA NÃO sincroniza leads
    // do site com o Twenty (o site é o dono dessa sincronização).
    await result.background?.()
    expect(crmSyncMock).not.toHaveBeenCalled()
    expect(lead.crm_person_id).toBeUndefined()
    expect(notifyDemoLeadMock).toHaveBeenCalledWith(
      expect.objectContaining({ nome: 'Duarte Silva', empresa: 'Plásticos do Norte', templateStatus: 'sent' }),
    )
  })

  it('segunda submissão com o mesmo telefone em 24 h é duplicada e não envia', async () => {
    await processWebLead(db.client, ACCOUNT, INPUT)
    engineSendTemplateMock.mockClear()

    const again = await processWebLead(db.client, ACCOUNT, { ...INPUT, telefone: '+351 912 345 678' })

    expect(again.outcome).toBe('duplicate')
    expect(engineSendTemplateMock).not.toHaveBeenCalled()
    expect(db.tables.web_leads).toHaveLength(1)
    expect(db.tables.contacts).toHaveLength(1)
  })

  it('passadas 24 h o mesmo telefone volta a ser processado', async () => {
    await processWebLead(db.client, ACCOUNT, INPUT)
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000)

    const again = await processWebLead(db.client, ACCOUNT, INPUT, later)

    expect(again.outcome).toBe('processed')
    expect(db.tables.web_leads).toHaveLength(2)
    // Contacto e conversa são reaproveitados.
    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.conversations).toHaveLength(1)
  })

  it('o mesmo event_id é duplicado mesmo com outro telefone', async () => {
    await processWebLead(db.client, ACCOUNT, { ...INPUT, event_id: 'evt-1' })
    const again = await processWebLead(db.client, ACCOUNT, {
      ...INPUT,
      telefone: '934 000 111',
      event_id: 'evt-1',
    })
    expect(again.outcome).toBe('duplicate')
    expect(engineSendTemplateMock).toHaveBeenCalledTimes(1)
  })

  it('sem consentimento: regista o motivo, não cria contacto nem envia, mas avisa a equipa', async () => {
    const result = await processWebLead(db.client, ACCOUNT, { ...INPUT, consentimento_whatsapp: false })

    expect(result.templateStatus).toBe('skipped_no_consent')
    expect(db.tables.web_leads[0].template_status).toBe('skipped_no_consent')
    expect(db.tables.contacts).toHaveLength(0)
    expect(engineSendTemplateMock).not.toHaveBeenCalled()

    await result.background?.()
    expect(notifyDemoLeadMock).toHaveBeenCalledWith(
      expect.objectContaining({ templateStatus: 'skipped_no_consent' }),
    )
    expect(crmSyncMock).not.toHaveBeenCalled()
  })

  it('telefone inválido: regista skipped_no_phone e não envia', async () => {
    const result = await processWebLead(db.client, ACCOUNT, { ...INPUT, telefone: 'xx' })

    expect(result.outcome).toBe('invalid_phone')
    expect(db.tables.web_leads[0]).toMatchObject({ template_status: 'skipped_no_phone', telefone: null })
    expect(engineSendTemplateMock).not.toHaveBeenCalled()
    expect(db.tables.contacts).toHaveLength(0)
  })

  it('template ainda não aprovado (132001): fica template_pendente', async () => {
    engineSendTemplateMock.mockRejectedValue(new Error('(#132001) Template name does not exist'))

    const result = await processWebLead(db.client, ACCOUNT, INPUT)

    expect(result.templateStatus).toBe('template_pendente')
    expect(db.tables.web_leads[0]).toMatchObject({
      template_status: 'template_pendente',
      template_name: 'eter_demo_web_v1',
    })
    // A conversa já existe, pronta para quando o template sair.
    expect(db.tables.conversations).toHaveLength(1)
  })

  it('outro erro de envio fica failed, não template_pendente', async () => {
    engineSendTemplateMock.mockRejectedValue(new Error('Meta API error: 500'))
    const result = await processWebLead(db.client, ACCOUNT, INPUT)
    expect(result.templateStatus).toBe('failed')
  })

  it('conversa existente VAZIA de outra origem passa a site_demo', async () => {
    db.tables.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '351912345678', name: 'Duarte' })
    db.tables.conversations.push({ id: 'cv-1', account_id: 'acct-1', contact_id: 'c-1', source: 'direct' })

    await processWebLead(db.client, ACCOUNT, INPUT)

    expect(db.tables.conversations).toHaveLength(1)
    expect(db.tables.conversations[0].source).toBe('site_demo')
    expect(engineSendTemplateMock).toHaveBeenCalledTimes(1)
  })

  it('conversa existente com histórico NÃO é convertida: não envia e avisa a equipa', async () => {
    db.tables.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '351912345678', name: 'Duarte' })
    db.tables.conversations.push({ id: 'cv-1', account_id: 'acct-1', contact_id: 'c-1', source: 'direct' })
    db.tables.messages = [{ id: 'm-1', conversation_id: 'cv-1' }]

    const result = await processWebLead(db.client, ACCOUNT, INPUT)

    expect(result.templateStatus).toBe('skipped_existing_conversation')
    expect(db.tables.conversations[0].source).toBe('direct')
    expect(engineSendTemplateMock).not.toHaveBeenCalled()
    expect(db.tables.web_leads[0]).toMatchObject({ dedupe_key: null })
    await result.background?.()
    expect(notifyDemoLeadMock).toHaveBeenCalledWith(
      expect.objectContaining({ templateStatus: 'skipped_existing_conversation' }),
    )
  })

  it('conversa com agente humano atribuído não é tocada', async () => {
    db.tables.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '351912345678', name: 'Duarte' })
    db.tables.conversations.push({
      id: 'cv-1',
      account_id: 'acct-1',
      contact_id: 'c-1',
      source: 'site_demo',
      assigned_agent_id: 'agent-1',
    })
    const result = await processWebLead(db.client, ACCOUNT, INPUT)
    expect(result.templateStatus).toBe('skipped_existing_conversation')
    expect(engineSendTemplateMock).not.toHaveBeenCalled()
  })

  it('uma demo anterior é reposta: IA reactivada, contador e equipa a zero', async () => {
    db.tables.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '351912345678', name: 'Duarte' })
    db.tables.conversations.push({
      id: 'cv-1',
      account_id: 'acct-1',
      contact_id: 'c-1',
      source: 'site_demo',
      ai_autoreply_disabled: true,
      ai_reply_count: 33,
      team_requested_at: null,
      handoff_blocked_attempts: 2,
    })
    db.tables.messages = [{ id: 'm-1', conversation_id: 'cv-1' }]

    const result = await processWebLead(db.client, ACCOUNT, INPUT)

    expect(result.templateStatus).toBe('sent')
    expect(db.tables.conversations[0]).toMatchObject({
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      team_requested_at: null,
      handoff_blocked_attempts: 0,
    })
  })

  it('uma demo já entregue à equipa não é reactivada', async () => {
    db.tables.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '351912345678', name: 'Duarte' })
    db.tables.conversations.push({
      id: 'cv-1',
      account_id: 'acct-1',
      contact_id: 'c-1',
      source: 'site_demo',
      ai_autoreply_disabled: false,
      team_requested_at: '2026-10-01T10:00:00Z',
    })
    const result = await processWebLead(db.client, ACCOUNT, INPUT)
    expect(result.templateStatus).toBe('skipped_existing_conversation')
    expect(db.tables.conversations[0].team_requested_at).toBe('2026-10-01T10:00:00Z')
    expect(engineSendTemplateMock).not.toHaveBeenCalled()
  })

  it('nunca sobrescreve o nome de um contacto existente', async () => {
    db.tables.contacts.push({
      id: 'c-1',
      account_id: 'acct-1',
      phone: '351912345678',
      name: 'Nome Verdadeiro',
      email: 'real@exemplo.pt',
    })
    await processWebLead(db.client, ACCOUNT, { ...INPUT, nome: 'Outro Nome' })
    expect(db.tables.contacts[0].name).toBe('Nome Verdadeiro')
    expect(db.tables.contacts[0].email).toBe('real@exemplo.pt')
  })
})

describe('processWebLead: concorrência, tecto e dedupe', () => {
  it('dois pedidos simultâneos para o mesmo telefone: só um envia', async () => {
    const [a, b] = await Promise.all([
      processWebLead(db.client, ACCOUNT, INPUT),
      processWebLead(db.client, ACCOUNT, { ...INPUT, event_id: 'outro' }),
    ])
    expect([a.outcome, b.outcome].sort()).toEqual(['duplicate', 'processed'])
    expect(engineSendTemplateMock).toHaveBeenCalledTimes(1)
    expect(db.tables.web_leads).toHaveLength(1)
  })

  it('vários pedidos simultâneos (mesmo telefone) enviam uma única vez', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => processWebLead(db.client, ACCOUNT, INPUT)),
    )
    expect(results.filter((r) => r.outcome === 'processed')).toHaveLength(1)
    expect(engineSendTemplateMock).toHaveBeenCalledTimes(1)
  })

  it('o mesmo número escrito de outra forma (+351, 00351, sem indicativo) é duplicado', async () => {
    await processWebLead(db.client, ACCOUNT, INPUT)
    for (const tel of ['+351912345678', '00351 912 345 678', '912-345-678']) {
      const again = await processWebLead(db.client, ACCOUNT, { ...INPUT, telefone: tel })
      expect(again.outcome).toBe('duplicate')
    }
    expect(engineSendTemplateMock).toHaveBeenCalledTimes(1)
  })

  it('avisa a equipa quando o dia chega a 80% do tecto, e no tecto', async () => {
    const recent = new Date().toISOString()
    const fill = (n: number) => {
      db.tables.web_leads.length = 0
      for (let i = 0; i < n; i++) {
        db.tables.web_leads.push({
          id: `wl-${i}`,
          account_id: 'acct-1',
          telefone: `3519100${String(i).padStart(5, '0')}`,
          template_status: 'sent',
          created_at: recent,
          updated_at: recent,
        })
      }
    }
    fill(79)
    await processWebLead(db.client, ACCOUNT, INPUT)
    expect(notifyCapWarningMock).not.toHaveBeenCalled()

    fill(80)
    await processWebLead(db.client, ACCOUNT, { ...INPUT, telefone: '934 111 222' })
    expect(notifyCapWarningMock).toHaveBeenCalledWith({ accountId: 'acct-1', count: 80, cap: WEB_LEAD_DAILY_CAP })

    notifyCapWarningMock.mockClear()
    fill(WEB_LEAD_DAILY_CAP)
    await processWebLead(db.client, ACCOUNT, { ...INPUT, telefone: '934 111 333' })
    expect(notifyCapWarningMock).toHaveBeenCalledWith(expect.objectContaining({ count: WEB_LEAD_DAILY_CAP }))
  })

  it('um envio falhado liberta o telefone para um novo pedido', async () => {
    engineSendTemplateMock.mockRejectedValueOnce(new Error('Meta API error: 500'))
    const first = await processWebLead(db.client, ACCOUNT, INPUT)
    expect(first.templateStatus).toBe('failed')
    expect(db.tables.web_leads[0].dedupe_key).toBeNull()

    const second = await processWebLead(db.client, ACCOUNT, INPUT)
    expect(second.outcome).toBe('processed')
    expect(second.templateStatus).toBe('sent')
  })

  it('um pedido sem consentimento não bloqueia o telefone', async () => {
    await processWebLead(db.client, ACCOUNT, { ...INPUT, consentimento_whatsapp: false })
    const again = await processWebLead(db.client, ACCOUNT, INPUT)
    expect(again.templateStatus).toBe('sent')
  })

  it('tecto diário por conta: a lead 101 é recusada', async () => {
    const recent = new Date().toISOString()
    for (let i = 0; i < WEB_LEAD_DAILY_CAP; i++) {
      db.tables.web_leads.push({
        id: `wl-${i}`,
        account_id: 'acct-1',
        telefone: `3519000${String(i).padStart(5, '0')}`,
        template_status: 'sent',
        created_at: recent,
        updated_at: recent,
      })
    }
    const result = await processWebLead(db.client, ACCOUNT, INPUT)
    expect(result.outcome).toBe('rate_limited')
    expect(engineSendTemplateMock).not.toHaveBeenCalled()
    expect(db.tables.web_leads).toHaveLength(WEB_LEAD_DAILY_CAP)
  })

  it('o tecto diário só conta leads que ocupam telefone', async () => {
    const recent = new Date().toISOString()
    for (let i = 0; i < WEB_LEAD_DAILY_CAP; i++) {
      db.tables.web_leads.push({
        id: `wl-${i}`,
        account_id: 'acct-1',
        template_status: 'failed',
        created_at: recent,
        updated_at: recent,
      })
    }
    expect((await processWebLead(db.client, ACCOUNT, INPUT)).outcome).toBe('processed')
  })

  it('o erro guardado e registado não contém telefones nem emails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    engineSendTemplateMock.mockRejectedValue(
      new Error('(#131030) Recipient 351912345678 duarte@exemplo.pt not allowed'),
    )
    await processWebLead(db.client, ACCOUNT, INPUT)
    const stored = String(db.tables.web_leads[0].template_error)
    expect(stored).not.toMatch(/351912345678|duarte@exemplo/)
    expect(stored).toContain('***')
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/351912345678|duarte@exemplo/)
    spy.mockRestore()
  })
})

describe('webLeadSchema: o que o site envia', () => {
  it('event_id null e n_comerciais "" contam como ausentes', () => {
    const r = webLeadSchema.safeParse({ ...INPUT, event_id: null, n_comerciais: '', utm: {} })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.event_id).toBeUndefined()
      expect(r.data.n_comerciais).toBeUndefined()
    }
  })
})

describe('webLeadSchema: texto não confiável e consentimento', () => {
  it('rejeita caracteres de controlo e quebras de linha em qualquer campo de texto', () => {
    for (const field of ['nome', 'empresa', 'n_comerciais', 'telefone', 'event_id'] as const) {
      for (const bad of ['a\nb', 'a\rb', 'a\u0000b', 'a\u2028b', 'a\tb']) {
        expect(webLeadSchema.safeParse({ ...INPUT, [field]: bad }).success, `${field} ${JSON.stringify(bad)}`).toBe(false)
      }
    }
    expect(webLeadSchema.safeParse({ ...INPUT, utm: { k: 'a\nb' } }).success).toBe(false)
  })

  it('com consentimento exige o texto e a página; sem consentimento não', () => {
    const { consentimento_texto: _t, pagina_url: _p, ...semProva } = INPUT
    void _t
    void _p
    expect(webLeadSchema.safeParse(semProva).success).toBe(false)
    expect(webLeadSchema.safeParse({ ...semProva, consentimento_whatsapp: false }).success).toBe(true)
  })
})

describe('retryPendingWebLeads', () => {
  const T0 = new Date('2026-10-08T10:00:00Z')
  const after = (ms: number) => new Date(T0.getTime() + ms)
  const MIN = 60 * 1000
  const NOT_READY = new Error('(#132001) Template name does not exist')

  async function pendingLead() {
    engineSendTemplateMock.mockRejectedValueOnce(NOT_READY)
    await processWebLead(db.client, ACCOUNT, INPUT, T0)
    expect(db.tables.web_leads[0].template_status).toBe('template_pendente')
    // O updated_at fictício acompanha o relógio do teste.
    db.tables.web_leads[0].created_at = T0.toISOString()
    db.tables.web_leads[0].updated_at = T0.toISOString()
    engineSendTemplateMock.mockReset()
    engineSendTemplateMock.mockResolvedValue({ whatsapp_message_id: 'wamid.2' })
  }

  it('reenvia quando o template já está aprovado (depois de 5 min)', async () => {
    await pendingLead()
    const out = await retryPendingWebLeads(db.client, after(6 * MIN))
    expect(out).toMatchObject({ sent: 1, stillPending: 0, failed: 0, expired: 0 })
    expect(db.tables.web_leads[0]).toMatchObject({ template_status: 'sent', template_attempts: 1 })
    expect(engineSendTemplateMock.mock.calls[0][0]).toMatchObject({ params: ['Duarte'] })
  })

  it('respeita o backoff: nada antes de 5 min', async () => {
    await pendingLead()
    expect(await retryPendingWebLeads(db.client, after(2 * MIN))).toMatchObject({ sent: 0 })
    expect(engineSendTemplateMock).not.toHaveBeenCalled()
  })

  it('continua pendente enquanto o template não for aprovado, com backoff crescente', async () => {
    await pendingLead()
    engineSendTemplateMock.mockRejectedValue(NOT_READY)

    let now = 6 * MIN
    expect(await retryPendingWebLeads(db.client, after(now))).toMatchObject({ stillPending: 1 })
    db.tables.web_leads[0].updated_at = after(now).toISOString()
    // 2.ª tentativa só passados 15 min.
    expect(await retryPendingWebLeads(db.client, after(now + 10 * MIN))).toMatchObject({ stillPending: 0 })
    now += 16 * MIN
    expect(await retryPendingWebLeads(db.client, after(now))).toMatchObject({ stillPending: 1 })
    expect(db.tables.web_leads[0].template_attempts).toBe(2)
  })

  it('depois de 5 tentativas expira: failed e aviso à equipa', async () => {
    await pendingLead()
    db.tables.web_leads[0].template_attempts = RETRY_MAX_ATTEMPTS
    db.tables.web_leads[0].updated_at = T0.toISOString()

    const out = await retryPendingWebLeads(db.client, after(7 * 60 * MIN))

    expect(out.expired).toBe(1)
    expect(db.tables.web_leads[0]).toMatchObject({ template_status: 'failed', dedupe_key: null })
    expect(notifyDemoLeadMock).toHaveBeenCalledWith(expect.objectContaining({ templateStatus: 'expired' }))
    expect(engineSendTemplateMock).not.toHaveBeenCalled()
  })

  it('passadas 24 h expira mesmo com tentativas por gastar', async () => {
    await pendingLead()
    const out = await retryPendingWebLeads(db.client, after(25 * 60 * MIN))
    expect(out.expired).toBe(1)
    expect(engineSendTemplateMock).not.toHaveBeenCalled()
  })

  it('não reenvia se o template já tinha saído (idempotência)', async () => {
    await pendingLead()
    db.tables.messages = [
      {
        id: 'm-1',
        conversation_id: db.tables.web_leads[0].conversation_id,
        template_name: 'eter_demo_web_v1',
        created_at: after(MIN).toISOString(),
      },
    ]
    const out = await retryPendingWebLeads(db.client, after(6 * MIN))
    expect(out.sent).toBe(1)
    expect(engineSendTemplateMock).not.toHaveBeenCalled()
  })

  it('um template de uma demo ANTERIOR na mesma conversa não conta como entregue', async () => {
    await pendingLead()
    db.tables.messages = [
      {
        id: 'm-0',
        conversation_id: db.tables.web_leads[0].conversation_id,
        template_name: 'eter_demo_web_v1',
        created_at: new Date(T0.getTime() - 3 * 24 * 60 * MIN).toISOString(),
      },
    ]
    const out = await retryPendingWebLeads(db.client, after(6 * MIN))
    expect(out.sent).toBe(1)
    expect(engineSendTemplateMock).toHaveBeenCalledTimes(1)
  })

  it('a recolha de presos é condicional: uma linha que mudou entretanto não é pisada', async () => {
    await pendingLead()
    db.tables.web_leads[0].template_status = 'sending'
    db.tables.web_leads[0].updated_at = T0.toISOString()
    // Simula o envio lento a concluir-se entre a leitura e a recolha.
    const original = db.client.from.bind(db.client)
    let tampered = false
    ;(db.client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const b = original(t) as { update: (p: Record<string, unknown>) => unknown }
      const upd = b.update.bind(b)
      b.update = (p) => {
        if (!tampered && t === 'web_leads' && p.template_status === 'sending') {
          tampered = true
          db.tables.web_leads[0].updated_at = after(10.5 * MIN).toISOString()
        }
        return upd(p)
      }
      return b
    }
    await retryPendingWebLeads(db.client, after(11 * MIN))
    expect(db.tables.web_leads[0].template_status).toBe('sending')
  })

  it('duas invocações seguidas não enviam duas vezes', async () => {
    await pendingLead()
    await retryPendingWebLeads(db.client, after(6 * MIN))
    await retryPendingWebLeads(db.client, after(7 * MIN))
    expect(engineSendTemplateMock).toHaveBeenCalledTimes(1)
  })

  it('recolhe um envio preso em sending há mais de 10 min', async () => {
    await pendingLead()
    db.tables.web_leads[0].template_status = 'sending'
    db.tables.web_leads[0].updated_at = T0.toISOString()

    expect(await retryPendingWebLeads(db.client, after(5 * MIN))).toMatchObject({ sent: 0, failed: 0 })
    expect(db.tables.web_leads[0].template_status).toBe('sending')

    await retryPendingWebLeads(db.client, after(11 * MIN))
    // Sem prova de envio: volta a template_pendente para o backoff tratar.
    expect(db.tables.web_leads[0].template_status).toBe('template_pendente')
  })

  it('um envio preso mas já entregue fica sent', async () => {
    await pendingLead()
    db.tables.web_leads[0].template_status = 'sending'
    db.tables.messages = [
      {
        id: 'm-1',
        conversation_id: db.tables.web_leads[0].conversation_id,
        template_name: 'eter_demo_web_v1',
        created_at: after(MIN).toISOString(),
      },
    ]
    const out = await retryPendingWebLeads(db.client, after(11 * MIN))
    expect(out.sent).toBe(1)
    expect(db.tables.web_leads[0].template_status).toBe('sent')
  })
})

describe('DEMO_TEST_PHONES: números de teste', () => {
  beforeEach(() => {
    process.env.DEMO_TEST_PHONES = '+351 912 345 678, 351999000111'
  })
  afterEach(() => {
    delete process.env.DEMO_TEST_PHONES
  })

  function seedExisting() {
    db.tables.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '351912345678', name: 'Ricardo' })
    db.tables.conversations.push({
      id: 'cv-old',
      account_id: 'acct-1',
      contact_id: 'c-1',
      source: 'direct',
      status: 'open',
      assigned_agent_id: 'agent-1',
      team_requested_at: '2026-10-01T10:00:00Z',
    })
    db.tables.messages = [{ id: 'm-1', conversation_id: 'cv-old', content_text: 'olá' }]
  }

  it('arquiva (não apaga) a conversa anterior e cria uma nova em modo demo', async () => {
    seedExisting()

    const result = await processWebLead(db.client, ACCOUNT, INPUT)

    expect(result.templateStatus).toBe('sent')
    const old = db.tables.conversations.find((c) => c.id === 'cv-old')!
    expect(old.status).toBe('closed')
    expect(old.contact_id).not.toBe('c-1')
    // As mensagens e a conversa antiga continuam lá.
    expect(db.tables.messages).toHaveLength(1)
    const archive = db.tables.contacts.find((c) => c.id === old.contact_id)!
    expect(String(archive.name)).toContain('[arquivo')
    expect(String(archive.phone)).toMatch(/^000/)

    const fresh = db.tables.conversations.find((c) => c.id !== 'cv-old')!
    expect(fresh).toMatchObject({ contact_id: 'c-1', source: 'site_demo' })
    expect(fresh.assigned_agent_id).toBeUndefined()
    expect(fresh.team_requested_at).toBeUndefined()
    expect(engineSendTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: fresh.id, contactId: 'c-1' }),
    )
  })

  it('o dedupe de 24 h não se aplica: dá para repetir o teste', async () => {
    await processWebLead(db.client, ACCOUNT, INPUT)
    const again = await processWebLead(db.client, ACCOUNT, INPUT)
    expect(again.outcome).toBe('processed')
    expect(again.templateStatus).toBe('sent')
    expect(engineSendTemplateMock).toHaveBeenCalledTimes(2)
  })

  it('o tecto diário continua a valer para números de teste', async () => {
    const recent = new Date().toISOString()
    for (let i = 0; i < WEB_LEAD_DAILY_CAP; i++) {
      db.tables.web_leads.push({ id: `wl-${i}`, account_id: 'acct-1', template_status: 'sent', created_at: recent, updated_at: recent })
    }
    expect((await processWebLead(db.client, ACCOUNT, INPUT)).outcome).toBe('rate_limited')
  })

  it('outros números mantêm o bloqueio de conversa existente', async () => {
    db.tables.contacts.push({ id: 'c-2', account_id: 'acct-1', phone: '351934111222', name: 'Outro' })
    db.tables.conversations.push({ id: 'cv-2', account_id: 'acct-1', contact_id: 'c-2', source: 'direct' })
    db.tables.messages = [{ id: 'm-2', conversation_id: 'cv-2' }]
    const result = await processWebLead(db.client, ACCOUNT, { ...INPUT, telefone: '934 111 222' })
    expect(result.templateStatus).toBe('skipped_existing_conversation')
    expect(db.tables.conversations).toHaveLength(1)
  })

  it('sem a env nada muda para o mesmo número', async () => {
    delete process.env.DEMO_TEST_PHONES
    seedExisting()
    const result = await processWebLead(db.client, ACCOUNT, INPUT)
    expect(result.templateStatus).toBe('skipped_existing_conversation')
  })
})
