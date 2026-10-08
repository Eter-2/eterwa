import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb, type FakeDb } from './fake-db.test-util'

const engineSendTemplateMock = vi.fn()
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendTemplate: (...args: unknown[]) => engineSendTemplateMock(...args),
}))
const syncWebLeadToCrmMock = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/crm/sync', () => ({
  syncWebLeadToCrm: (...args: unknown[]) => syncWebLeadToCrmMock(...args),
}))
const notifyDemoLeadMock = vi.fn().mockResolvedValue({ mattermost: { sent: true, via: 'webhook' }, whatsapp: [] })
vi.mock('@/lib/notifications/notify-team', () => ({
  notifyDemoLead: (...args: unknown[]) => notifyDemoLeadMock(...args),
}))

import {
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
  syncWebLeadToCrmMock.mockClear()
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
    expect(normalizeWebPhone('+44 7700 900123')).toBe('447700900123')
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
      telefone: '351912345678',
      contact_id: contact.id,
      conversation_id: conv.id,
    })

    // Twenty e aviso à equipa correm em background, depois da resposta.
    expect(syncWebLeadToCrmMock).not.toHaveBeenCalled()
    await result.background?.()
    expect(syncWebLeadToCrmMock).toHaveBeenCalledWith(
      expect.objectContaining({ webLeadId: lead.id, contactId: contact.id, email: 'duarte@exemplo.pt' }),
    )
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
    expect(syncWebLeadToCrmMock).not.toHaveBeenCalled()
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

  it('conversa existente de outra origem passa a site_demo', async () => {
    db.tables.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '351912345678', name: 'Duarte' })
    db.tables.conversations.push({ id: 'cv-1', account_id: 'acct-1', contact_id: 'c-1', source: 'direct' })

    await processWebLead(db.client, ACCOUNT, INPUT)

    expect(db.tables.conversations).toHaveLength(1)
    expect(db.tables.conversations[0].source).toBe('site_demo')
  })
})

describe('retryPendingWebLeads', () => {
  async function pendingLead() {
    engineSendTemplateMock.mockRejectedValueOnce(new Error('(#132001) Template name does not exist'))
    await processWebLead(db.client, ACCOUNT, INPUT)
    expect(db.tables.web_leads[0].template_status).toBe('template_pendente')
    engineSendTemplateMock.mockClear()
  }
  const later = () => new Date(Date.now() + 5 * 60 * 1000)

  it('reenvia quando o template já está aprovado', async () => {
    await pendingLead()

    const out = await retryPendingWebLeads(db.client, later())

    expect(out).toEqual({ sent: 1, stillPending: 0, failed: 0 })
    expect(db.tables.web_leads[0]).toMatchObject({ template_status: 'sent', template_attempts: 1 })
    expect(engineSendTemplateMock).toHaveBeenCalledTimes(1)
    expect(engineSendTemplateMock.mock.calls[0][0]).toMatchObject({ params: ['Duarte'] })
  })

  it('continua pendente enquanto o template não for aprovado', async () => {
    await pendingLead()
    engineSendTemplateMock.mockRejectedValue(new Error('(#132001) Template name does not exist'))

    const out = await retryPendingWebLeads(db.client, later())

    expect(out).toEqual({ sent: 0, stillPending: 1, failed: 0 })
    expect(db.tables.web_leads[0].template_status).toBe('template_pendente')
  })

  it('não mexe em leads muito recentes (intervalo mínimo) nem em leads velhas', async () => {
    await pendingLead()
    expect(await retryPendingWebLeads(db.client, new Date())).toEqual({ sent: 0, stillPending: 0, failed: 0 })

    const muitoDepois = new Date(Date.now() + 49 * 60 * 60 * 1000)
    expect(await retryPendingWebLeads(db.client, muitoDepois)).toEqual({ sent: 0, stillPending: 0, failed: 0 })
    expect(engineSendTemplateMock).not.toHaveBeenCalled()
  })

  it('duas invocações seguidas não enviam duas vezes', async () => {
    await pendingLead()
    await retryPendingWebLeads(db.client, later())
    await retryPendingWebLeads(db.client, later())
    expect(engineSendTemplateMock).toHaveBeenCalledTimes(1)
  })
})
