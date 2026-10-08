// ============================================================
// web-leads.ts — lead do site (landings da Vera) → contacto +
// conversa 'site_demo' → template eter_demo_web_v1.
//
// Chamado por POST /api/leads/web (src/app/api/leads/web/route.ts).
// Mesmo desenho e mesma disciplina de src/lib/meta/leads.ts (Lead
// Ads): a linha de `web_leads` é reservada logo no início, o contacto
// e a conversa são idempotentes, e nenhuma falha a jusante (Twenty,
// aviso à equipa, envio do template) derruba o registo da lead.
//
// Dedupe: (1) `event_id` do site, único por conta (índice parcial);
// (2) telefone normalizado numa janela de 24 h. Uma segunda submissão
// dentro da janela devolve 'duplicate' e não envia nada.
//
// Template ainda não aprovado: a lead fica em `template_pendente` e o
// cron do agente (/api/eter-agent/cron) chama `retryPendingWebLeads`
// até o template sair ou a lead ficar velha demais.
//
// Nada é enviado sem consentimento WhatsApp nem a um telefone inválido:
// a lead fica registada com o motivo em `template_status`.
// ============================================================

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parsePhoneNumberFromString } from 'libphonenumber-js/max'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { engineSendTemplate } from '@/lib/automations/meta-send'
import { syncWebLeadToCrm } from '@/lib/crm/sync'
import { notifyDemoLead, notifyDemoCapWarning } from '@/lib/notifications/notify-team'
import { firstNameForTemplate } from '@/lib/eter/followups'
import { findOrCreateLeadContact, isTemplateNotReadyError, type NormalizedLead } from './leads'
import { cleanField, hasControlChars, maskPii } from './lead-sanitize'
import { DEMO_CONVERSATION_SOURCE } from '@/lib/ai/demo'
import { DEMO_TEMPLATE_LANGUAGE, demoTemplateName } from './demo-template'

export const WEB_LEAD_SOURCES = ['lp-vera-whatsapp', 'lp-vera-linkedin'] as const

/** Janela de dedupe por telefone. */
export const WEB_LEAD_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000

/** Tecto de templates (leads que ocupam telefone) por conta em 24 h. */
export const WEB_LEAD_DAILY_CAP = 100

/** A equipa é avisada quando o dia chega a 80% do tecto. */
export const WEB_LEAD_CAP_WARNING = 80

/** Leads em `template_pendente` mais velhas do que isto deixam de ser
 *  reenviadas: a lead é marcada como falhada e a equipa é avisada. */
export const WEB_LEAD_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Espera antes de cada reenvio (índice = tentativas já feitas). Cinco
 *  tentativas ao longo da janela de 24 h; a Meta demora de minutos a
 *  horas a aprovar um template. */
const MIN = 60 * 1000
const RETRY_BACKOFF_MS = [5 * MIN, 15 * MIN, 60 * MIN, 3 * 60 * MIN, 6 * 60 * MIN]
export const RETRY_MAX_ATTEMPTS = RETRY_BACKOFF_MS.length

/** Um envio reservado ('pending'/'sending') há mais do que isto é
 *  considerado preso (processo morto) e é recolhido. */
const STUCK_AFTER_MS = 10 * MIN

/** Estados em que a lead ocupa o telefone (dedupe e tecto diário). */
const OCCUPYING_STATUSES = ['pending', 'sending', 'sent', 'template_pendente'] as const

const noControl = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !hasControlChars(v), { message: 'caracteres de controlo não permitidos' })

const utmSchema = z
  .record(noControl(60), noControl(300, 0))
  .refine((o) => Object.keys(o).length <= 20, { message: 'utm: demasiadas chaves' })

export const webLeadSchema = z
  .object({
    nome: noControl(120),
    telefone: noControl(40),
    email: noControl(200).pipe(z.email()),
    empresa: noControl(160),
    n_comerciais: noControl(40).optional(),
    source: z.enum(WEB_LEAD_SOURCES),
    consentimento_whatsapp: z.boolean(),
    // Prova de consentimento: texto da checkbox e página onde foi dada.
    consentimento_texto: noControl(500, 10).optional(),
    pagina_url: noControl(300).pipe(z.url()).optional(),
    user_agent: noControl(300).optional(),
    ip_visitante: noControl(45).optional(),
    utm: utmSchema.optional(),
    event_id: noControl(100).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.consentimento_whatsapp && !v.consentimento_texto) {
      ctx.addIssue({ code: 'custom', path: ['consentimento_texto'], message: 'obrigatório com consentimento' })
    }
    if (v.consentimento_whatsapp && !v.pagina_url) {
      ctx.addIssue({ code: 'custom', path: ['pagina_url'], message: 'obrigatório com consentimento' })
    }
  })

export type WebLeadInput = z.infer<typeof webLeadSchema>

/**
 * Telefone do formulário → dígitos com indicativo (E.164 sem "+"), ou
 * null se não for um número válido. Usa o libphonenumber com Portugal
 * como país por omissão (as landings são portuguesas), por isso
 * "912 345 678", "+351 912 345 678" e "00351912345678" dão o mesmo
 * resultado e prefixos/comprimentos impossíveis são recusados.
 */
export function normalizeWebPhone(raw: string): string | null {
  const text = raw.trim().replace(/^00/, '+')
  const parsed = parsePhoneNumberFromString(text, 'PT')
  if (!parsed || !parsed.isValid()) return null
  return parsed.number.replace(/^\+/, '')
}

/** Chave de comparação do telefone: últimos 9 dígitos (o mesmo número
 *  escrito com ou sem indicativo ou zeros à frente é a mesma pessoa). */
export function phoneSuffix(phone: string): string {
  return phone.slice(-9)
}
export type WebLeadOutcome = 'processed' | 'duplicate' | 'invalid_phone' | 'rate_limited'

export type WebLeadTemplateStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'template_pendente'
  | 'failed'
  | 'skipped_no_consent'
  | 'skipped_no_phone'
  | 'skipped_existing_conversation'

/** Estados que libertam o telefone para um novo pedido. */
const FREEING_STATUSES: readonly WebLeadTemplateStatus[] = [
  'failed',
  'skipped_no_consent',
  'skipped_no_phone',
  'skipped_existing_conversation',
]

export interface WebLeadResult {
  outcome: WebLeadOutcome
  webLeadId?: string
  templateStatus?: WebLeadTemplateStatus
  /** Trabalho que pode correr depois da resposta (Twenty, aviso à
   *  equipa). O chamador passa-o a `after()`; nunca lança. */
  background?: () => Promise<void>
}

export interface WebLeadAccount {
  accountId: string
  userId: string
}

export interface WebLeadRequestMeta {
  /** IP do pedido (hop de confiança), para a prova de consentimento. */
  requestIp?: string | null
}

/**
 * Conta dona do número de WhatsApp da Vera. `LEADS_WEB_ACCOUNT_ID`
 * fixa-a explicitamente; sem a env, só é aceite se existir exactamente
 * uma `whatsapp_config` (mesma salvaguarda de findConfigForPage: um
 * mapeamento ambíguo nunca escolhe uma conta ao acaso).
 */
export async function resolveWebLeadAccount(
  db: SupabaseClient,
  explicitAccountId: string | undefined = process.env.LEADS_WEB_ACCOUNT_ID?.trim() || undefined,
): Promise<WebLeadAccount | null> {
  let query = db.from('whatsapp_config').select('account_id, user_id')
  if (explicitAccountId) query = query.eq('account_id', explicitAccountId)
  const { data, error } = await query
  if (error) {
    console.error('[web leads] falha a procurar whatsapp_config:', error.message)
    return null
  }
  if (!data || data.length === 0) return null
  if (data.length > 1) {
    console.error(
      `[web leads] múltiplas whatsapp_config (${data.length}) e LEADS_WEB_ACCOUNT_ID não definido. Lead recusada.`,
    )
    return null
  }
  const row = data[0] as { account_id: string; user_id: string }
  return { accountId: row.account_id, userId: row.user_id }
}

interface WebLeadRow {
  id: string
  account_id: string
  nome: string
  telefone: string | null
  email: string | null
  empresa: string | null
  n_comerciais: string | null
  source: string
  contact_id: string | null
  conversation_id: string | null
  template_attempts: number
  template_status: WebLeadTemplateStatus
  created_at: string
  updated_at: string
}

const LEAD_ROW_COLUMNS =
  'id, account_id, nome, telefone, email, empresa, n_comerciais, source, contact_id, conversation_id, template_attempts, template_status, created_at, updated_at'

async function setTemplateStatus(
  db: SupabaseClient,
  accountId: string,
  webLeadId: string,
  status: WebLeadTemplateStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const patch: Record<string, unknown> = { template_status: status, ...extra }
  if (typeof patch.template_error === 'string') patch.template_error = maskPii(patch.template_error).slice(0, 500)
  // Ao falhar ou saltar, o telefone fica livre para um novo pedido.
  if (FREEING_STATUSES.includes(status)) patch.dedupe_key = null
  const { error } = await db
    .from('web_leads')
    .update(patch)
    .eq('id', webLeadId)
    .eq('account_id', accountId)
  if (error) {
    console.error(
      `[web leads] falha a gravar template_status=${status} (lead=${webLeadId}):`,
      error.message,
    )
  }
}

/** True se a conversa já tem uma mensagem de template nossa (idempotência
 *  do reenvio: o envio pode ter saído antes de o estado ser gravado). */
async function hasTemplateMessage(
  db: SupabaseClient,
  conversationId: string,
  templateName: string,
  sinceIso: string,
): Promise<boolean> {
  // Só conta mensagens desde que ESTA lead foi criada: um template de uma
  // demo anterior na mesma conversa não prova que este pedido foi servido.
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('template_name', templateName)
    .gte('created_at', sinceIso)
    .limit(1)
  if (error) {
    console.error('[web leads] falha a verificar template já enviado:', error.message)
    return false
  }
  return Array.isArray(data) && data.length > 0
}

/** Envia o template e grava o resultado em `web_leads`. Nunca lança. */
async function sendDemoTemplate(
  db: SupabaseClient,
  lead: Pick<WebLeadRow, 'id' | 'account_id' | 'nome' | 'contact_id' | 'conversation_id'>,
  userId: string,
): Promise<WebLeadTemplateStatus> {
  const templateName = demoTemplateName()
  if (!lead.contact_id || !lead.conversation_id) {
    await setTemplateStatus(db, lead.account_id, lead.id, 'failed', {
      template_name: templateName,
      template_error: 'lead sem contacto/conversa',
    })
    return 'failed'
  }
  try {
    const sendResult = await engineSendTemplate({
      accountId: lead.account_id,
      userId,
      conversationId: lead.conversation_id,
      contactId: lead.contact_id,
      templateName,
      language: DEMO_TEMPLATE_LANGUAGE,
      params: [firstNameForTemplate(lead.nome)],
    })
    await setTemplateStatus(db, lead.account_id, lead.id, 'sent', {
      template_name: templateName,
      template_message_id: sendResult.whatsapp_message_id,
      template_error: null,
    })
    return 'sent'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const notReady = isTemplateNotReadyError(msg)
    const status: WebLeadTemplateStatus = notReady ? 'template_pendente' : 'failed'
    await setTemplateStatus(db, lead.account_id, lead.id, status, {
      template_name: templateName,
      template_error: msg,
    })
    console.error(
      `[web leads] envio do template falhou (lead=${lead.id}, template=${templateName}, pronto=${!notReady}):`,
      maskPii(msg),
    )
    return status
  }
}

type DemoConversation = { id: string } | { blocked: true }

/**
 * Conversa onde a demo decorre. O webhook de mensagens resolve SEMPRE a
 * conversa mais antiga do contacto, por isso é essa que se usa. Só é
 * convertida/reposta se for uma demo anterior ou estiver vazia; uma
 * conversa real com histórico, ou com agente humano atribuído, não se
 * toca (devolve `blocked` e a equipa é avisada).
 */
async function prepareDemoConversation(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string,
  demoContext: Record<string, unknown>,
  reason: string,
): Promise<DemoConversation> {
  const findExisting = () =>
    db
      .from('conversations')
      .select('id, source, assigned_agent_id, team_requested_at')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)

  const { data: existingRows, error: findErr } = await findExisting()
  if (findErr) throw new Error(`falha a procurar conversa da lead do site: ${findErr.message}`)

  if (existingRows && existingRows.length > 0) {
    const row = existingRows[0] as {
      id: string
      source: string | null
      assigned_agent_id: string | null
      team_requested_at: string | null
    }
    if (row.assigned_agent_id) return { blocked: true }
    // Demo já entregue à equipa: uma pessoa pode estar a tratar dela, não
    // se volta a ligar a IA.
    if (row.source === DEMO_CONVERSATION_SOURCE && row.team_requested_at) return { blocked: true }

    if (row.source !== DEMO_CONVERSATION_SOURCE) {
      const { data: msgs, error: msgErr } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', row.id)
        .limit(1)
      if (msgErr) throw new Error(`falha a verificar mensagens da conversa: ${msgErr.message}`)
      if (msgs && msgs.length > 0) return { blocked: true }
    }

    // Demo anterior ou conversa vazia: repõe o estado para uma demo nova.
    const { error: updErr } = await db
      .from('conversations')
      .update({
        source: DEMO_CONVERSATION_SOURCE,
        demo_context: demoContext,
        escalation_reason: reason,
        ai_autoreply_disabled: false,
        ai_reply_count: 0,
        team_requested_at: null,
        handoff_blocked_attempts: 0,
      })
      .eq('id', row.id)
      .eq('account_id', accountId)
    if (updErr) throw new Error(`falha a repor a conversa como site_demo: ${updErr.message}`)
    return { id: row.id }
  }

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      source: DEMO_CONVERSATION_SOURCE,
      demo_context: demoContext,
      // O motivo já é conhecido (pediu a demo), por isso a trava de
      // handoff do modo comercial (nome, email, motivo, empresa) não
      // bloqueia um pedido para falar com a equipa.
      escalation_reason: reason,
    })
    .select('id')
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await findExisting()
      if (raced && raced.length > 0) return { id: (raced[0] as { id: string }).id }
    }
    throw new Error(`falha a criar conversa da lead do site: ${error.message}`)
  }
  return { id: (created as { id: string }).id }
}

function dedupeKey(phone: string, now: Date): string {
  return `${phoneSuffix(phone)}:${Math.floor(now.getTime() / WEB_LEAD_DEDUPE_WINDOW_MS)}`
}

export async function processWebLead(
  db: SupabaseClient,
  account: WebLeadAccount,
  input: WebLeadInput,
  now: Date = new Date(),
  meta: WebLeadRequestMeta = {},
): Promise<WebLeadResult> {
  const { accountId, userId } = account
  const phone = normalizeWebPhone(input.telefone)
  const since = new Date(now.getTime() - WEB_LEAD_DEDUPE_WINDOW_MS).toISOString()

  // Tecto diário por conta (rede de segurança contra abuso com a chave).
  const { data: occupying, error: capErr } = await db
    .from('web_leads')
    .select('id')
    .eq('account_id', accountId)
    .gte('created_at', since)
    .in('template_status', [...OCCUPYING_STATUSES])
    .limit(WEB_LEAD_DAILY_CAP)
  if (capErr) throw new Error(`falha a verificar o tecto diário: ${capErr.message}`)
  const occupiedToday = occupying?.length ?? 0
  if (occupiedToday === WEB_LEAD_CAP_WARNING || occupiedToday === WEB_LEAD_DAILY_CAP) {
    void notifyDemoCapWarning({ accountId, count: occupiedToday, cap: WEB_LEAD_DAILY_CAP }).catch(
      (err) => console.error('[web leads] aviso de tecto falhou:', maskPii(String(err))),
    )
  }
  if (occupiedToday >= WEB_LEAD_DAILY_CAP) {
    console.error(`[web leads] tecto diário de ${WEB_LEAD_DAILY_CAP} leads atingido (account=${accountId}).`)
    return { outcome: 'rate_limited' }
  }

  // Dedupe por telefone numa janela de 24 h: só conta quem ainda ocupa o
  // telefone (um envio falhado não bloqueia uma nova tentativa).
  if (phone) {
    const { data: recent, error: recentErr } = await db
      .from('web_leads')
      .select('id, template_status')
      .eq('account_id', accountId)
      .like('telefone', `%${phoneSuffix(phone)}`)
      .gte('created_at', since)
      .in('template_status', [...OCCUPYING_STATUSES])
      .order('created_at', { ascending: false })
      .limit(1)
    if (recentErr) throw new Error(`falha a verificar duplicados em web_leads: ${recentErr.message}`)
    if (recent && recent.length > 0) {
      const row = recent[0] as { id: string; template_status: WebLeadTemplateStatus }
      return { outcome: 'duplicate', webLeadId: row.id, templateStatus: row.template_status }
    }
  }

  const consent = input.consentimento_whatsapp === true
  const initialStatus: WebLeadTemplateStatus = !phone
    ? 'skipped_no_phone'
    : !consent
      ? 'skipped_no_consent'
      : 'pending'

  // A inserção é o árbitro: o índice UNIQUE (account_id, dedupe_key) só
  // deixa passar UM pedido concorrente para o mesmo telefone; quem perde
  // recebe 23505 e sai como duplicado sem enviar nada.
  const { data: inserted, error: insertErr } = await db
    .from('web_leads')
    .insert({
      account_id: accountId,
      source: input.source,
      event_id: input.event_id ?? null,
      nome: input.nome,
      telefone_raw: input.telefone,
      telefone: phone,
      email: input.email,
      empresa: input.empresa,
      n_comerciais: input.n_comerciais ?? null,
      utm: input.utm ?? null,
      consentimento_whatsapp: consent,
      consent_at: consent ? now.toISOString() : null,
      consent_text: consent ? (input.consentimento_texto ?? null) : null,
      consent_url: consent ? (input.pagina_url ?? null) : null,
      consent_user_agent: consent ? (input.user_agent ?? null) : null,
      consent_visitor_ip: consent ? (input.ip_visitante ?? null) : null,
      consent_request_ip: consent ? (meta.requestIp ?? null) : null,
      dedupe_key: initialStatus === 'pending' && phone ? dedupeKey(phone, now) : null,
      template_status: initialStatus,
    })
    .select('id')
    .maybeSingle()

  if (insertErr) {
    if (isUniqueViolation(insertErr)) return { outcome: 'duplicate' }
    throw new Error(`falha a registar web_leads: ${insertErr.message}`)
  }
  const webLeadId = (inserted as { id: string }).id

  const notify = (status: string, conversationId: string | null) =>
    notifyDemoLead({
      accountId,
      nome: input.nome,
      empresa: input.empresa,
      nComerciais: input.n_comerciais ?? null,
      source: input.source,
      phone,
      email: input.email,
      templateStatus: status,
      conversationUrl: conversationId
        ? `${process.env.ETERWA_INBOX_URL ?? 'https://eterwa.etergrowth.com/inbox'}?c=${encodeURIComponent(conversationId)}`
        : null,
    }).then(
      () => undefined,
      (err) => console.error('[web leads] notifyDemoLead falhou:', maskPii(String(err))),
    )

  // Sem telefone válido ou sem consentimento: regista (já está feito) e
  // avisa a equipa para contactar por email. Não cria contacto nem envia.
  if (initialStatus !== 'pending') {
    return {
      outcome: phone ? 'processed' : 'invalid_phone',
      webLeadId,
      templateStatus: initialStatus,
      background: async () => {
        await notify(initialStatus, null)
      },
    }
  }

  try {
    // Reserva o envio: a partir daqui só este pedido envia.
    await setTemplateStatus(db, accountId, webLeadId, 'sending')

    const normalized: NormalizedLead = {
      fullName: input.nome,
      email: input.email,
      phone: phone!,
      company: input.empresa,
      consent: true,
    }
    // Nunca sobrescreve o nome de um contacto que já existe.
    const contact = await findOrCreateLeadContact(db, accountId, userId, normalized, {
      updateName: false,
    })
    const conversation = await prepareDemoConversation(
      db,
      accountId,
      userId,
      contact.id,
      {
        origem: input.source,
        // Dados do formulário, fonte do convite da reunião (o modelo não os altera).
        nome: input.nome,
        email: input.email,
        empresa: input.empresa,
        n_comerciais: input.n_comerciais ?? null,
        utm: input.utm ?? null,
        web_lead_id: webLeadId,
      },
      `Pediu a demo da Vera no site (${input.source})${input.n_comerciais ? `, ${input.n_comerciais} comerciais` : ''}`,
    )

    if ('blocked' in conversation) {
      await setTemplateStatus(db, accountId, webLeadId, 'skipped_existing_conversation', {
        contact_id: contact.id,
      })
      return {
        outcome: 'processed',
        webLeadId,
        templateStatus: 'skipped_existing_conversation',
        background: async () => {
          await notify('skipped_existing_conversation', null)
        },
      }
    }

    const { error: linkErr } = await db
      .from('web_leads')
      .update({ contact_id: contact.id, conversation_id: conversation.id })
      .eq('id', webLeadId)
      .eq('account_id', accountId)
    if (linkErr) throw new Error(`falha a ligar a lead ao contacto/conversa: ${linkErr.message}`)

    const templateStatus = await sendDemoTemplate(
      db,
      {
        id: webLeadId,
        account_id: accountId,
        nome: input.nome,
        contact_id: contact.id,
        conversation_id: conversation.id,
      },
      userId,
    )

    return {
      outcome: 'processed',
      webLeadId,
      templateStatus,
      background: async () => {
        await Promise.all([
          syncWebLeadToCrm({
            db,
            accountId,
            webLeadId,
            contactId: contact.id,
            email: input.email,
          }),
          notify(templateStatus, conversation.id),
        ])
      },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await setTemplateStatus(db, accountId, webLeadId, 'failed', { template_error: msg })
    console.error(`[web leads] processamento falhou (lead=${webLeadId}):`, maskPii(msg))
    return {
      outcome: 'processed',
      webLeadId,
      templateStatus: 'failed',
      background: async () => {
        await notify('failed', null)
      },
    }
  }
}

/**
 * Cron do agente: (1) recolhe envios presos há mais de 10 min (processo
 * morto entre reservar e gravar o resultado); (2) reenvia o template às
 * leads em `template_pendente` com backoff (5 min, 15 min, 1 h, 3 h,
 * 6 h); (3) expira as que ultrapassaram as 5 tentativas ou as 24 h,
 * marcando-as `failed` e avisando a equipa. Reserva cada linha com um
 * UPDATE condicional (template_pendente → sending), por isso duas
 * invocações sobrepostas nunca enviam duas vezes, e antes de enviar
 * confirma que o template não saiu já. Nunca lança.
 */
export async function retryPendingWebLeads(
  db: SupabaseClient,
  now: Date = new Date(),
  limit = 50,
): Promise<{ sent: number; stillPending: number; failed: number; expired: number }> {
  const result = { sent: 0, stillPending: 0, failed: 0, expired: 0 }
  const templateName = demoTemplateName()
  try {
    const { data, error } = await db
      .from('web_leads')
      .select(LEAD_ROW_COLUMNS)
      .in('template_status', ['pending', 'sending', 'template_pendente'])
      .order('created_at', { ascending: true })
      .limit(limit)
    if (error) {
      console.error('[web leads] retry: falha a listar leads pendentes:', error.message)
      return result
    }

    for (const row of (data ?? []) as WebLeadRow[]) {
      const age = now.getTime() - new Date(row.created_at).getTime()
      const idle = now.getTime() - new Date(row.updated_at).getTime()

      // (1) Presas em pending/sending.
      if (row.template_status !== 'template_pendente') {
        if (idle < STUCK_AFTER_MS) continue
        // Recolha condicional: só quem ainda encontra a linha no mesmo
        // estado e sem actividade nova a recolhe (um envio lento que
        // acabou entretanto não é pisado).
        const { data: reclaimed, error: reclaimErr } = await db
          .from('web_leads')
          .update({ template_status: row.template_status })
          .eq('id', row.id)
          .eq('account_id', row.account_id)
          .eq('template_status', row.template_status)
          .eq('updated_at', row.updated_at)
          .select('id')
        if (reclaimErr || !reclaimed || reclaimed.length === 0) continue
        if (row.conversation_id && (await hasTemplateMessage(db, row.conversation_id, templateName, row.created_at))) {
          await setTemplateStatus(db, row.account_id, row.id, 'sent', { template_name: templateName })
          result.sent++
        } else if (row.contact_id && row.conversation_id) {
          await setTemplateStatus(db, row.account_id, row.id, 'template_pendente')
        } else {
          await setTemplateStatus(db, row.account_id, row.id, 'failed', {
            template_error: 'processamento interrompido',
          })
          result.failed++
        }
        continue
      }

      // (3) Expirada.
      if (age > WEB_LEAD_RETRY_MAX_AGE_MS || row.template_attempts >= RETRY_MAX_ATTEMPTS) {
        if (row.template_attempts >= RETRY_MAX_ATTEMPTS && idle < RETRY_BACKOFF_MS[RETRY_MAX_ATTEMPTS - 1]) {
          continue // dá à última tentativa o seu tempo antes de desistir
        }
        await setTemplateStatus(db, row.account_id, row.id, 'failed', {
          template_error: 'template não aprovado a tempo',
        })
        result.expired++
        void notifyDemoLead({
          accountId: row.account_id,
          nome: row.nome,
          empresa: row.empresa,
          nComerciais: row.n_comerciais,
          source: row.source,
          phone: row.telefone,
          email: row.email,
          templateStatus: 'expired',
          conversationUrl: null,
        }).catch((err) => console.error('[web leads] aviso de expiração falhou:', maskPii(String(err))))
        continue
      }

      // (2) Reenvio com backoff.
      if (idle < RETRY_BACKOFF_MS[row.template_attempts]) continue

      const { data: claimed, error: claimErr } = await db
        .from('web_leads')
        .update({ template_status: 'sending', template_attempts: row.template_attempts + 1 })
        .eq('id', row.id)
        .eq('account_id', row.account_id)
        .eq('template_status', 'template_pendente')
        .select('id')
      if (claimErr || !claimed || claimed.length === 0) continue

      if (row.conversation_id && (await hasTemplateMessage(db, row.conversation_id, templateName, row.created_at))) {
        await setTemplateStatus(db, row.account_id, row.id, 'sent', { template_name: templateName })
        result.sent++
        continue
      }
      const account = await resolveWebLeadAccount(db, row.account_id)
      if (!account) {
        await setTemplateStatus(db, row.account_id, row.id, 'template_pendente')
        continue
      }
      const status = await sendDemoTemplate(db, row, account.userId)
      if (status === 'sent') result.sent++
      else if (status === 'template_pendente') result.stillPending++
      else result.failed++
    }
  } catch (err) {
    console.error('[web leads] retry falhou:', maskPii(err instanceof Error ? err.message : String(err)))
  }
  return result
}
