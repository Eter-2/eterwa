import type { SupabaseClient } from '@supabase/supabase-js'
import {
  scheduleMessages,
  cancelScheduledMessagesForConversation,
  cancelRemindersForBooking,
  FOLLOW_UP_KINDS,
} from './repo/scheduled-messages.repo'
import type { Booking } from './repo/bookings.repo'
import { getLastInboundMessageText } from './repo/messages.repo'

// ============================================================
// Quiet-lead follow-up cadence + meeting-reminder scheduling — the
// product logic on top of `agent_scheduled_messages`
// (scheduled-messages.repo.ts) and the `/api/eter-agent/cron` sweep
// that actually sends what's queued here.
//
// Cadence (T+1 / T+3 / T+7 days) — triggered when
// `save_lead_qualification` sets `lead_qualification.stage = 'morno'`
// for a conversation (see the handler wiring in
// src/lib/ai/tools/handlers/save-lead-qualification.ts):
//   T+1 — resume the thread, referencing what was being discussed.
//   T+3 — share something useful, no ask.
//   T+7 — last attempt, clean exit.
//   After T+7: nothing further, ever, for this quiet period — there is
//   no T+14/T+30 step. A NEW cadence only starts the next time the
//   lead replies and later goes quiet again in stage 'morno' — this
//   file has no memory of "already tried once" beyond the presence of
//   pending rows, which is exactly the terminal behaviour required.
//
// Cancellation — either an inbound reply from the lead (any message,
// not just to a follow-up) or a booking becoming confirmed cancels the
// pending cadence for that conversation. Both call sites live outside
// this file (the webhook route and pending-confirmation.ts,
// respectively) — this module only exposes the primitive.
//
// Copy generation is deliberately NOT an LLM call: this module runs
// synchronously at scheduling time (webhook / tool-handler request
// path), and firing a second LLM request off the back of a
// save_lead_qualification tool call would add real latency + cost to
// every agent turn that reaches 'morno'. The T+1 message uses a short,
// honest excerpt of the lead's last message as the "referencing what
// was being discussed" hook instead of a generated summary — a
// documented, deliberate scope cut for this pass.
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

async function buildFollowUp1dText(db: SupabaseClient, conversationId: string): Promise<string> {
  const lastText = await getLastInboundMessageText(db, conversationId).catch(() => null)
  if (lastText) {
    return `Olá! Ainda a pensar em "${truncate(lastText, 80)}"? Fico por aqui se quiser continuar a conversa.`
  }
  return 'Olá! Ainda por aí? Fico por aqui se quiser continuar a conversa.'
}

const FOLLOW_UP_3D_TEXT =
  'Só a passar para partilhar um dado rápido: empresas como a sua costumam ver resultados concretos ' +
  'logo nas primeiras semanas com a Eter Growth. Sem compromisso, fico à disposição se fizer sentido.'

const FOLLOW_UP_7D_TEXT =
  'Não quero encher a sua caixa de mensagens, esta é a última vez que escrevo sobre isto. ' +
  'Se mudar alguma coisa da sua parte, escreva-me noutra altura.'

/**
 * Schedule the T+1 / T+3 / T+7 quiet-lead cadence for a conversation,
 * anchored to `now`. Cancels any previously-pending cadence for the
 * same conversation first, so calling this more than once (e.g. the
 * agent re-saves `stage: 'morno'` on the same lead) never produces
 * duplicate rows — the partial unique index in migration 039 would
 * reject a naive re-insert anyway, but cancel-then-insert is the
 * documented pattern for that reason.
 */
export async function scheduleFollowUpCadence(
  db: SupabaseClient,
  accountId: string,
  args: { conversationId: string; contactId: string | null },
  now: Date = new Date(),
): Promise<void> {
  const { conversationId, contactId } = args

  await cancelScheduledMessagesForConversation(db, accountId, conversationId, {
    kinds: FOLLOW_UP_KINDS,
  })

  const followUp1dText = await buildFollowUp1dText(db, conversationId)

  await scheduleMessages(db, accountId, [
    {
      conversationId,
      contactId,
      kind: 'follow_up_1d',
      sendAt: new Date(now.getTime() + 1 * DAY_MS),
      payload: { freeText: followUp1dText },
    },
    {
      conversationId,
      contactId,
      kind: 'follow_up_3d',
      sendAt: new Date(now.getTime() + 3 * DAY_MS),
      payload: { freeText: FOLLOW_UP_3D_TEXT },
    },
    {
      conversationId,
      contactId,
      kind: 'follow_up_7d',
      sendAt: new Date(now.getTime() + 7 * DAY_MS),
      payload: { freeText: FOLLOW_UP_7D_TEXT },
    },
  ])
}

// ============================================================
// Cadência dos leads de anúncio Click-to-WhatsApp (`source = 'meta_ad'`).
// Agendada quando a abertura fixa é enviada (ver
// `sendCommercialWelcomeIfNeeded`), para TODOS os leads de anúncio e não
// só os 'morno'. Reutiliza os kinds `follow_up_1d` / `follow_up_3d` (e por
// isso o cancelamento em qualquer inbound, o cancel-then-insert e os
// índices únicos da migração 039), distinguindo o conteúdo pelo payload:
//   Passo 1, T+22h desde o último inbound (ainda dentro da janela de
//     24h): texto livre.
//   Passo 2, T+3 dias (fora da janela): template Meta
//     `eter_reativacao_v1` (pt_PT) com 1 variável de corpo, o primeiro
//     nome. Se o template não estiver aprovado, o cron marca a linha
//     `failed` com erro claro, nunca envia texto livre fora da janela.
// Não há passo T+7. Sem backfill: só conversas cuja abertura sai depois
// deste código estar em produção.
// ============================================================

export const AD_NUDGE_DELAY_MS = 22 * HOUR_MS
export const AD_REACTIVATION_DELAY_MS = 3 * DAY_MS

export const AD_NUDGE_TEXT =
  'Olá! Ficou alguma dúvida? Conte-me em uma frase o que faz a sua empresa e mostro-lhe como o agente ficaria no seu caso.'

export const AD_REACTIVATION_TEMPLATE_NAME = 'eter_reativacao_v1'
export const AD_REACTIVATION_TEMPLATE_LANGUAGE = 'pt_PT'

/** Valor da variável {{1}} quando não há um primeiro nome utilizável. */
export const TEMPLATE_FIRST_NAME_FALLBACK = 'olá'

/**
 * Primeiro nome do contacto para a variável {{1}} do template. Nunca
 * devolve vazio (a Meta rejeita parâmetros vazios): sem nome, ou com um
 * nome que não é utilizável (só números, emojis, símbolos), devolve o
 * fallback.
 */
export function firstNameForTemplate(name: string | null | undefined): string {
  if (!name) return TEMPLATE_FIRST_NAME_FALLBACK
  const firstToken = name.trim().split(/\s+/)[0] ?? ''
  const letters = firstToken.replace(/[^\p{L}'-]/gu, '').replace(/^['-]+|['-]+$/g, '')
  if (letters.length === 0 || letters.length > 30) return TEMPLATE_FIRST_NAME_FALLBACK
  return letters
}

/** Payload do passo de template (lido por `/api/eter-agent/cron`). */
export interface ScheduledTemplatePayload {
  name: string
  language: string
  /** Quando true, o cron resolve {{1}} = primeiro nome do contacto no
   *  momento do envio (o nome pode ter sido preenchido entretanto). */
  firstNameParam?: boolean
}

/**
 * Agenda a cadência de 2 passos de um lead de anúncio, ancorada a `now`
 * (o inbound que acabou de abrir a conversa). Cancel-then-insert, tal
 * como `scheduleFollowUpCadence`.
 */
export async function scheduleAdLeadCadence(
  db: SupabaseClient,
  accountId: string,
  args: { conversationId: string; contactId: string | null },
  now: Date = new Date(),
): Promise<void> {
  const { conversationId, contactId } = args

  await cancelScheduledMessagesForConversation(db, accountId, conversationId, {
    kinds: FOLLOW_UP_KINDS,
  })

  const template: ScheduledTemplatePayload = {
    name: AD_REACTIVATION_TEMPLATE_NAME,
    language: AD_REACTIVATION_TEMPLATE_LANGUAGE,
    firstNameParam: true,
  }

  await scheduleMessages(db, accountId, [
    {
      conversationId,
      contactId,
      kind: 'follow_up_1d',
      sendAt: new Date(now.getTime() + AD_NUDGE_DELAY_MS),
      payload: { freeText: AD_NUDGE_TEXT },
    },
    {
      conversationId,
      contactId,
      kind: 'follow_up_3d',
      sendAt: new Date(now.getTime() + AD_REACTIVATION_DELAY_MS),
      payload: { template },
    },
  ])
}

/** Cancel the pending quiet-lead cadence (not meeting reminders — those
 *  are booking-scoped, see `cancelRemindersForBooking`) for a
 *  conversation. Called on any inbound reply and on a booking becoming
 *  confirmed. */
export async function cancelFollowUpCadence(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<void> {
  await cancelScheduledMessagesForConversation(db, accountId, conversationId, {
    kinds: FOLLOW_UP_KINDS,
  })
}

function formatBookingTime(startsAt: Date): string {
  return startsAt.toLocaleString('pt-PT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Schedule T-24h / T-2h reminders for a confirmed booking. Cancels any
 * previously-pending reminders for the same booking first (so a
 * reschedule that changes `starts_at` gets fresh reminder times
 * instead of firing at the old slot). Reminders whose fire time has
 * already passed (e.g. the meeting was booked less than 24h/2h out)
 * are silently skipped rather than scheduled in the past — the cron
 * sweep would otherwise fire them immediately, which isn't a
 * "reminder" for a booking made 10 minutes ago.
 */
export async function scheduleMeetingReminders(
  db: SupabaseClient,
  accountId: string,
  booking: Booking,
  now: Date = new Date(),
): Promise<void> {
  await cancelRemindersForBooking(db, accountId, booking.id)

  const when = formatBookingTime(booking.startsAt)
  const candidates = [
    {
      kind: 'reminder_24h' as const,
      sendAt: new Date(booking.startsAt.getTime() - 24 * HOUR_MS),
      freeText: `Lembrete: tens uma reunião amanhã, ${when}. Até já!`,
    },
    {
      kind: 'reminder_2h' as const,
      sendAt: new Date(booking.startsAt.getTime() - 2 * HOUR_MS),
      freeText: `Lembrete: a tua reunião é daqui a 2h, ${when}. Até já!`,
    },
  ].filter((c) => c.sendAt.getTime() > now.getTime())

  if (candidates.length === 0) return

  await scheduleMessages(
    db,
    accountId,
    candidates.map((c) => ({
      conversationId: booking.conversationId,
      contactId: booking.contactId,
      bookingId: booking.id,
      kind: c.kind,
      sendAt: c.sendAt,
      payload: { freeText: c.freeText },
    })),
  )
}
