import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/flows/meta-send'
import { scheduleAdLeadCadence } from '@/lib/eter/followups'
import { normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils'
import type { AiConfig } from './types'

// ============================================================
// Bloco 3-A — commercial mode.
//
// O número de WhatsApp da Eter está num anúncio pago (público), por
// isso QUALQUER pessoa que escreva, venha do anúncio ou directamente,
// é um desconhecido para o negócio. A conversa é "comercial" POR
// OMISSÃO, desde que a conta tenha ligado a persona
// (`ai_configs.commercial_mode_enabled`) e configurado um prompt
// comercial. A ÚNICA excepção é um número que conste na lista da
// equipa (`ai_configs.team_phone_numbers`) — esses continuam a apanhar
// o assistente interno (`systemPrompt`), independentemente da origem
// da conversa. Lista vazia = toda a gente comercial (comportamento
// seguro por omissão). Ver `dispatchInboundToAiReply` (auto-reply.ts).
// ============================================================

export function isCommercialConversation(
  config: Pick<AiConfig, 'commercialModeEnabled' | 'commercialSystemPrompt' | 'teamPhoneNumbers'>,
  contactPhone: string | null | undefined,
): boolean {
  if (config.commercialModeEnabled !== true) return false
  if (!config.commercialSystemPrompt || !config.commercialSystemPrompt.trim()) return false

  const team = config.teamPhoneNumbers ?? []
  if (team.length > 0 && contactPhone && normalizePhone(contactPhone).length > 0) {
    // phonesMatch (not raw equality) so a trunk-0 or country-code
    // formatting difference between the stored contact number and the
    // team list still matches — same tolerance already used elsewhere
    // for comparing WhatsApp numbers (see phone-utils.ts).
    const isTeamMember = team.some((n) => phonesMatch(n, contactPhone))
    if (isTeamMember) return false
  }

  return true
}

/**
 * Abertura fixa, enviada de imediato na primeira mensagem de uma
 * conversa comercial. É o texto único para conversas vindas de anúncio
 * (`conversations.source = 'meta_ad'`) e também a boas-vindas por
 * omissão das conversas directas sem `commercial_welcome_message`
 * próprio. Sem pergunta de cargo e sem variação por anúncio (decisão do
 * Ricardo, 29/09/2026). A IA só responde a partir da mensagem seguinte
 * do lead (ver `dispatchInboundToAiReply`).
 */
export const DEFAULT_COMMERCIAL_WELCOME_MESSAGE =
  'Olá! Sou a Vera, da Eter Growth. Com quem estou a falar?'


/**
 * Fixed fallback sent when the AI call fails, times out, or returns no
 * usable text in commercial mode. Not configurable today — deliberately
 * short and generic so it never contradicts whatever the AI would have
 * said, and never invents facts. The point is only to guarantee some
 * reply lands inside WhatsApp's 24h session window; a human follows up
 * from the inbox regardless.
 */
export const DEFAULT_COMMERCIAL_FALLBACK_MESSAGE =
  'Recebemos a sua mensagem, obrigada. Estamos só a confirmar uns detalhes e respondemos já de seguida.'

/** True se a conversa já tem alguma mensagem nossa (sender_type 'agent'
 *  ou 'bot': templates, envios humanos ou da IA). */
export async function hasOutboundMessage(
  db: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .limit(1)
  if (error) {
    console.error(
      '[ai auto-reply] commercial welcome: falha a verificar mensagens outbound:',
      error.message,
    )
    return false
  }
  return Array.isArray(data) && data.length > 0
}

interface WelcomeArgs {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  welcomeMessage: string | null | undefined
  /** `conversations.source` (migração 045). Quando `'meta_ad'`, a abertura é
   *  sempre o texto fixo (ignora `welcomeMessage`) e agenda-se a cadência
   *  de follow-up dos leads de anúncio. */
  source?: string | null
}

/**
 * Send the commercial welcome message exactly once per conversation.
 *
 * WHY: WhatsApp only allows free-form replies within 24h of the
 * customer's last message ("session window"); if nobody replies in
 * time, the thread locks and re-opening it requires a Meta-approved
 * template. The AI reply that answers the lead's actual message can be
 * slow, can time out, or can fail outright — so this welcome is sent
 * FIRST and unconditionally (see dispatchInboundToAiReply), before any
 * AI call, to guarantee the window stays open regardless of what
 * happens next.
 *
 * Idempotency: an atomic "claim" UPDATE sets
 * `commercial_welcome_sent_at` only WHERE it is still NULL (same
 * pattern as `claim_ai_reply_slot` in migration 029's atomic-claim
 * comment) — so two inbound messages landing close together, or a
 * webhook retry, can never send this twice. Never throws: a failure
 * here must not block the rest of the auto-reply flow.
 *
 * Devolve `true` só quando a abertura foi enviada AGORA, neste inbound;
 * o chamador não deve então correr a IA (nem o fallback) neste turno.
 */
export async function sendCommercialWelcomeIfNeeded(args: WelcomeArgs): Promise<boolean> {
  const { db, accountId, conversationId, contactId, configOwnerUserId, welcomeMessage, source } = args
  try {
    // Se já saiu alguma mensagem nossa nesta conversa (template de
    // outreach do AI SDR, mensagem de um humano, etc.), o lead já foi
    // tratado e a abertura fixa ("Com quem estou a falar?") seria
    // errada. Marca a abertura como enviada (best-effort) e deixa a IA
    // responder normalmente. Erro de leitura conta como "sem outbound":
    // a abertura é a rede de segurança da janela de 24h.
    if (await hasOutboundMessage(db, conversationId)) {
      const { error: markErr } = await db
        .from('conversations')
        .update({ commercial_welcome_sent_at: new Date().toISOString() })
        .eq('id', conversationId)
        .is('commercial_welcome_sent_at', null)
      if (markErr) {
        console.error(
          '[ai auto-reply] commercial welcome: falha a marcar a abertura como já enviada:',
          markErr.message,
        )
      }
      return false
    }

    const { data: claimedRows, error } = await db
      .from('conversations')
      .update({ commercial_welcome_sent_at: new Date().toISOString() })
      .eq('id', conversationId)
      .is('commercial_welcome_sent_at', null)
      .select('id')

    if (error) {
      console.error(
        '[ai auto-reply] commercial welcome: falha ao reservar o envio único:',
        error.message,
      )
      return false
    }
    if (!claimedRows || claimedRows.length === 0) return false // already sent, or lost the race

    // Conversa vinda de anúncio: texto fixo, independentemente de a
    // conta ter um `commercial_welcome_message` próprio (esse continua a
    // valer para conversas directas, source !== 'meta_ad').
    const isAdLead = source === 'meta_ad'
    const text =
      !isAdLead && welcomeMessage && welcomeMessage.trim()
        ? welcomeMessage.trim()
        : DEFAULT_COMMERCIAL_WELCOME_MESSAGE

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: false,
    })

    if (isAdLead) {
      // Cadência de follow-up para todos os leads de anúncio. Best-effort:
      // uma falha aqui nunca desfaz a abertura já enviada.
      try {
        await scheduleAdLeadCadence(db, accountId, { conversationId, contactId })
      } catch (err) {
        console.error(
          '[ai auto-reply] commercial welcome: falha ao agendar a cadência do lead de anúncio:',
          err instanceof Error ? err.message : err,
        )
      }
    }
    return true
  } catch (err) {
    console.error(
      '[ai auto-reply] commercial welcome send failed:',
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

interface FallbackArgs {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
}

const FALLBACK_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** True se o fallback fixo já saiu nesta conversa nas últimas 24h.
 *  Lê `messages` (o envio grava-se lá com este mesmo texto), por isso
 *  não precisa de coluna nova. Erro de leitura conta como "não saiu"
 *  (regista e deixa passar: o fallback é a rede de segurança). */
export async function hasRecentCommercialFallback(
  db: SupabaseClient,
  conversationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - FALLBACK_COOLDOWN_MS).toISOString()
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'bot')
    .eq('content_text', DEFAULT_COMMERCIAL_FALLBACK_MESSAGE)
    .gte('created_at', since)
    .limit(1)
  if (error) {
    console.error(
      '[ai auto-reply] commercial fallback: falha a verificar o limite de 24h:',
      error.message,
    )
    return false
  }
  return Array.isArray(data) && data.length > 0
}

/**
 * Guaranteed reply for commercial mode when the AI call fails, times
 * out, or returns no usable text (see dispatchInboundToAiReply). Sai no
 * máximo uma vez por conversa em cada 24h, para não haver cadeias de
 * "Recebemos a sua mensagem" seguidas; se já saiu, regista o erro e não
 * envia nada. Never throws — callers treat this as best-effort, same
 * discipline as the rest of the auto-reply / webhook cascade.
 * Devolve `true` se enviou.
 */
export async function sendCommercialFallback(args: FallbackArgs): Promise<boolean> {
  const { db, accountId, conversationId, contactId, configOwnerUserId } = args
  try {
    if (await hasRecentCommercialFallback(db, conversationId)) {
      console.error(
        '[ai auto-reply] commercial fallback: já saiu nas últimas 24h nesta conversa, não envia outro.',
      )
      return false
    }
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: DEFAULT_COMMERCIAL_FALLBACK_MESSAGE,
      aiGenerated: false,
    })
    return true
  } catch (err) {
    console.error(
      '[ai auto-reply] commercial fallback send failed:',
      err instanceof Error ? err.message : err,
    )
    return false
  }
}
