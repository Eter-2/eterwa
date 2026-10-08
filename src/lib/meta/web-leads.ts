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
import { normalizePhone, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { engineSendTemplate } from '@/lib/automations/meta-send'
import { syncWebLeadToCrm } from '@/lib/crm/sync'
import { notifyDemoLead } from '@/lib/notifications/notify-team'
import { firstNameForTemplate } from '@/lib/eter/followups'
import { findOrCreateLeadContact, isTemplateNotReadyError, type NormalizedLead } from './leads'
import { DEMO_CONVERSATION_SOURCE } from '@/lib/ai/demo'
import { DEMO_TEMPLATE_LANGUAGE, demoTemplateName } from './demo-template'

export const WEB_LEAD_SOURCES = ['lp-vera-whatsapp', 'lp-vera-linkedin'] as const

/** Janela de dedupe por telefone. */
export const WEB_LEAD_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000

/** Leads em `template_pendente` mais velhas do que isto deixam de ser
 *  reenviadas (o pedido já arrefeceu; a equipa viu o aviso). */
export const WEB_LEAD_RETRY_MAX_AGE_MS = 48 * 60 * 60 * 1000

/** Intervalo mínimo entre tentativas de reenvio da mesma lead. */
const RETRY_MIN_INTERVAL_MS = 2 * 60 * 1000

/** Tecto de tentativas de reenvio por lead (rede de segurança). */
const RETRY_MAX_ATTEMPTS = 200

const utmSchema = z
  .record(z.string().max(60), z.string().max(300))
  .refine((o) => Object.keys(o).length <= 20, {
    message: 'utm: demasiadas chaves',
  })

export const webLeadSchema = z.object({
  nome: z.string().trim().min(1).max(120),
  telefone: z.string().trim().min(1).max(40),
  email: z.string().trim().max(200).pipe(z.email()),
  empresa: z.string().trim().min(1).max(160),
  n_comerciais: z.string().trim().max(40).optional(),
  source: z.enum(WEB_LEAD_SOURCES),
  consentimento_whatsapp: z.boolean(),
  utm: utmSchema.optional(),
  event_id: z.string().trim().min(1).max(100).optional(),
})

export type WebLeadInput = z.infer<typeof webLeadSchema>

/**
 * Telefone do formulário → dígitos com indicativo, ou null se não for
 * utilizável. As landings são portuguesas: 9 dígitos a começar por 2 ou
 * 9 ganham o indicativo 351; "00" inicial é lido como "+".
 */
export function normalizeWebPhone(raw: string): string | null {
  let digits = normalizePhone(raw)
  if (!digits) return null
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.length === 9 && /^[29]/.test(digits)) digits = `351${digits}`
  return isValidE164(digits) ? digits : null
}

export type WebLeadOutcome = 'processed' | 'duplicate' | 'invalid_phone'

export type WebLeadTemplateStatus =
  'pending' | 'sent' | 'template_pendente' | 'failed' | 'skipped_no_consent' | 'skipped_no_phone'

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
  contact_id: string | null
  conversation_id: string | null
  template_attempts: number
}

async function setTemplateStatus(
  db: SupabaseClient,
  webLeadId: string,
  status: WebLeadTemplateStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db
    .from('web_leads')
    .update({ template_status: status, ...extra })
    .eq('id', webLeadId)
  if (error) {
    console.error(
      `[web leads] falha a gravar template_status=${status} (lead=${webLeadId}):`,
      error.message,
    )
  }
}

/** Envia o template e grava o resultado em `web_leads`. Nunca lança. */
async function sendDemoTemplate(
  db: SupabaseClient,
  lead: Pick<WebLeadRow, 'id' | 'account_id' | 'nome' | 'contact_id' | 'conversation_id'>,
  userId: string,
): Promise<WebLeadTemplateStatus> {
  const templateName = demoTemplateName()
  if (!lead.contact_id || !lead.conversation_id) {
    await setTemplateStatus(db, lead.id, 'failed', {
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
    await setTemplateStatus(db, lead.id, 'sent', {
      template_name: templateName,
      template_message_id: sendResult.whatsapp_message_id,
      template_error: null,
    })
    return 'sent'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const notReady = isTemplateNotReadyError(msg)
    const status: WebLeadTemplateStatus = notReady ? 'template_pendente' : 'failed'
    await setTemplateStatus(db, lead.id, status, {
      template_name: templateName,
      template_error: msg.slice(0, 500),
    })
    console.error(
      `[web leads] envio do template falhou (lead=${lead.id}, template=${templateName}, pronto=${!notReady}):`,
      msg,
    )
    return status
  }
}

async function findOrCreateDemoConversation(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  contactId: string,
  demoContext: Record<string, unknown>,
  reason: string,
): Promise<{ id: string }> {
  const findExisting = () =>
    db
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)

  const { data: existingRows, error: findErr } = await findExisting()
  if (findErr) throw new Error(`falha a procurar conversa da lead do site: ${findErr.message}`)
  if (existingRows && existingRows.length > 0) {
    const id = (existingRows[0] as { id: string }).id
    // A pessoa acabou de pedir a demo: a conversa passa a modo demo.
    const { error: updErr } = await db
      .from('conversations')
      .update({
        source: DEMO_CONVERSATION_SOURCE,
        demo_context: demoContext,
        escalation_reason: reason,
      })
      .eq('id', id)
    if (updErr) throw new Error(`falha a marcar a conversa como site_demo: ${updErr.message}`)
    return { id }
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

export async function processWebLead(
  db: SupabaseClient,
  account: WebLeadAccount,
  input: WebLeadInput,
  now: Date = new Date(),
): Promise<WebLeadResult> {
  const { accountId, userId } = account
  const phone = normalizeWebPhone(input.telefone)

  // Dedupe por telefone numa janela de 24 h (só para telefones válidos).
  if (phone) {
    const since = new Date(now.getTime() - WEB_LEAD_DEDUPE_WINDOW_MS).toISOString()
    const { data: recent, error: recentErr } = await db
      .from('web_leads')
      .select('id, template_status')
      .eq('account_id', accountId)
      .eq('telefone', phone)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
    if (recentErr) {
      throw new Error(`falha a verificar duplicados em web_leads: ${recentErr.message}`)
    }
    if (recent && recent.length > 0) {
      const row = recent[0] as {
        id: string
        template_status: WebLeadTemplateStatus
      }
      return {
        outcome: 'duplicate',
        webLeadId: row.id,
        templateStatus: row.template_status,
      }
    }
  }

  const consent = input.consentimento_whatsapp === true
  const initialStatus: WebLeadTemplateStatus = !phone
    ? 'skipped_no_phone'
    : !consent
      ? 'skipped_no_consent'
      : 'pending'

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
      template_status: initialStatus,
    })
    .select('id')
    .maybeSingle()

  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      // Mesmo event_id já recebido.
      return { outcome: 'duplicate' }
    }
    throw new Error(`falha a registar web_leads: ${insertErr.message}`)
  }
  const webLeadId = (inserted as { id: string }).id

  const notify = (status: WebLeadTemplateStatus, conversationId: string | null) =>
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
      (err) => console.error('[web leads] notifyDemoLead falhou:', err),
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
    const normalized: NormalizedLead = {
      fullName: input.nome,
      email: input.email,
      phone: phone!,
      company: input.empresa,
      consent: true,
    }
    const contact = await findOrCreateLeadContact(db, accountId, userId, normalized)
    const conversation = await findOrCreateDemoConversation(
      db,
      accountId,
      userId,
      contact.id,
      {
        origem: input.source,
        empresa: input.empresa,
        n_comerciais: input.n_comerciais ?? null,
        utm: input.utm ?? null,
        web_lead_id: webLeadId,
      },
      `Pediu a demo da Vera no site (${input.source})${input.n_comerciais ? `, ${input.n_comerciais} comerciais` : ''}`,
    )

    await db
      .from('web_leads')
      .update({ contact_id: contact.id, conversation_id: conversation.id })
      .eq('id', webLeadId)

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
    await setTemplateStatus(db, webLeadId, 'failed', {
      template_error: msg.slice(0, 500),
    })
    console.error(`[web leads] processamento falhou (lead=${webLeadId}):`, msg)
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
 * Reenvia o template às leads em `template_pendente` (template ainda
 * não aprovado quando entraram). Chamado pelo cron do agente. Reserva
 * cada linha com um UPDATE condicional (template_pendente → pending)
 * para que duas invocações sobrepostas nunca enviem duas vezes.
 * Devolve quantas foram enviadas. Nunca lança.
 */
export async function retryPendingWebLeads(
  db: SupabaseClient,
  now: Date = new Date(),
  limit = 20,
): Promise<{ sent: number; stillPending: number; failed: number }> {
  const result = { sent: 0, stillPending: 0, failed: 0 }
  try {
    const youngerThan = new Date(now.getTime() - WEB_LEAD_RETRY_MAX_AGE_MS).toISOString()
    const idleSince = new Date(now.getTime() - RETRY_MIN_INTERVAL_MS).toISOString()
    const { data, error } = await db
      .from('web_leads')
      .select('id, account_id, nome, contact_id, conversation_id, template_attempts')
      .eq('template_status', 'template_pendente')
      .gte('created_at', youngerThan)
      .lte('updated_at', idleSince)
      .order('created_at', { ascending: true })
      .limit(limit)
    if (error) {
      console.error('[web leads] retry: falha a listar leads pendentes:', error.message)
      return result
    }

    for (const row of (data ?? []) as WebLeadRow[]) {
      if (row.template_attempts >= RETRY_MAX_ATTEMPTS) continue
      const { data: claimed, error: claimErr } = await db
        .from('web_leads')
        .update({
          template_status: 'pending',
          template_attempts: row.template_attempts + 1,
        })
        .eq('id', row.id)
        .eq('template_status', 'template_pendente')
        .select('id')
      if (claimErr || !claimed || claimed.length === 0) continue

      const account = await resolveWebLeadAccount(db, row.account_id)
      if (!account) {
        await setTemplateStatus(db, row.id, 'template_pendente')
        continue
      }
      const status = await sendDemoTemplate(db, row, account.userId)
      if (status === 'sent') result.sent++
      else if (status === 'template_pendente') result.stillPending++
      else result.failed++
    }
  } catch (err) {
    console.error('[web leads] retry falhou:', err instanceof Error ? err.message : err)
  }
  return result
}
