import type { SupabaseClient } from '@supabase/supabase-js'
import { META_API_BASE } from '@/lib/whatsapp/meta-api'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import {
  buildTemplateRow,
  type MetaTemplate,
} from '@/lib/whatsapp/template-meta-row'
import type { MessageTemplate } from '@/types'

// ============================================================
// Texto de um template enviado, para gravar em `messages.content_text`
// e em `conversations.last_message_text`. Sem isto a bolha do Inbox
// fica vazia, a lista mostra "[template]" e a IA não vê o que já foi
// dito ao lead.
// ============================================================

/** Substitui {{N}} pelos parâmetros (1-indexado); deixa {{N}} se faltar. */
export function renderTemplateBody(
  body: string,
  params: readonly string[] = [],
): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw: string) => {
    const value = params[Number(raw) - 1]
    return value === undefined || value === null ? `{{${raw}}}` : String(value)
  })
}

/** Só usado quando não há maneira de obter o corpo do template. */
export function templateFallbackText(name: string): string {
  return `[template: ${name}]`
}

/** Extrai os valores do corpo de `template_message_params`/`params`. */
export function templateBodyParams(
  messageParams: unknown,
  legacyParams?: readonly string[],
): string[] {
  if (
    messageParams &&
    typeof messageParams === 'object' &&
    Array.isArray((messageParams as { body?: unknown }).body)
  ) {
    return ((messageParams as { body: unknown[] }).body).map((v) => String(v))
  }
  return legacyParams ? [...legacyParams] : []
}

/**
 * Texto final de um template: corpo renderizado com os params, ou o
 * fallback `[template: nome]` se o corpo não estiver disponível.
 */
export function templateMessageText(
  template: Pick<MessageTemplate, 'body_text'> | null | undefined,
  name: string,
  params: readonly string[] = [],
): string {
  const body = template?.body_text?.trim()
  return body ? renderTemplateBody(body, params) : templateFallbackText(name)
}

export interface EnsureTemplateArgs {
  accountId: string
  /** Autor a gravar em `message_templates.user_id` (NOT NULL). */
  userId?: string | null
  wabaId?: string | null
  accessToken: string
  name: string
  language: string
}

/**
 * Linha local do template, ou (se não existir) buscada à Graph API.
 * Para quem não faz já a sua própria leitura local (ex.: engine).
 */
export async function ensureTemplateRow(
  db: SupabaseClient,
  args: EnsureTemplateArgs,
): Promise<MessageTemplate | null> {
  const { data: local } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', args.accountId)
    .eq('name', args.name)
    .eq('language', args.language)
    .maybeSingle()
  if (local) return isMessageTemplate(local) ? local : null
  return fetchAndStoreTemplate(db, args)
}

/**
 * Vai buscar o template à Graph API e grava-o em `message_templates`
 * (best-effort). Usado quando a linha local não existe (o sync manual
 * nunca correu para ele, ex.: template criado directamente na Meta).
 * Devolve null se falhar; quem chama usa o fallback e o envio segue.
 */
export async function fetchAndStoreTemplate(
  db: SupabaseClient,
  args: EnsureTemplateArgs,
): Promise<MessageTemplate | null> {
  const { accountId, userId, wabaId, accessToken, name, language } = args

  if (!wabaId) return null
  try {
    const url =
      `${META_API_BASE}/${wabaId}/message_templates` +
      `?name=${encodeURIComponent(name)}&limit=25` +
      `&fields=id,name,language,status,category,components,quality_score`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      console.warn(`[template-render] Graph ${res.status} ao obter "${name}"`)
      return null
    }
    const body = (await res.json()) as { data?: MetaTemplate[] }
    const meta = (body.data ?? []).find(
      (t) => t.name === name && t.language === language,
    )
    if (!meta) return null

    if (!userId) {
      // Sem autor não dá para gravar (user_id NOT NULL): usa só o corpo.
      const row = buildTemplateRow(meta, { accountId, userId: '' })
      return { ...row, id: '', created_at: '' } as unknown as MessageTemplate
    }
    const { data: saved, error } = await db
      .from('message_templates')
      .insert(buildTemplateRow(meta, { accountId, userId }))
      .select('*')
      .single()
    if (error || !saved) {
      console.warn(
        `[template-render] upsert de "${name}" falhou:`,
        error?.message,
      )
      const row = buildTemplateRow(meta, { accountId, userId })
      return { ...row, id: '', created_at: '' } as unknown as MessageTemplate
    }
    return isMessageTemplate(saved) ? saved : null
  } catch (err) {
    console.warn(
      '[template-render] falha ao obter template da Meta:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}
