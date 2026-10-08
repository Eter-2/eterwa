import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { processWebLead, resolveWebLeadAccount, webLeadSchema } from '@/lib/meta/web-leads'

// ============================================================
// POST /api/leads/web — formulário das landings da Vera
// (lp-vera-whatsapp, lp-vera-linkedin). Chamado pelo SERVIDOR do site,
// nunca pelo browser: a chave vai em `X-Lead-Key` e é comparada em
// tempo constante com `LEADS_WEB_KEY`. Sem a env, 503 (fail closed).
//
// Contrato e exemplos: README-ETER.md, secção "Lead do site → demo".
// Lógica: src/lib/meta/web-leads.ts.
// ============================================================

export const maxDuration = 60

/** Corpo máximo aceite (o formulário real tem < 2 KB). */
const MAX_BODY_BYTES = 8 * 1024

/** Por IP (o site passa o IP real em X-Forwarded-For) e global. */
const RATE_LIMIT_PER_IP = { limit: 10, windowMs: 60_000 }
const RATE_LIMIT_GLOBAL = { limit: 120, windowMs: 60_000 }

function keyMatches(supplied: string, expected: string): boolean {
  // Hash dos dois lados: tempo constante e comprimentos iguais, sem
  // revelar o tamanho da chave.
  const a = createHash('sha256').update(supplied).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')
  const first = fwd?.split(',')[0]?.trim()
  return first || request.headers.get('x-real-ip') || 'unknown'
}

export async function POST(request: Request) {
  const expectedKey = process.env.LEADS_WEB_KEY
  if (!expectedKey) {
    console.error('[leads web] LEADS_WEB_KEY não definida — a recusar pedidos.')
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  const supplied = request.headers.get('x-lead-key') ?? ''
  if (!supplied || !keyMatches(supplied, expectedKey)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limit depois da autenticação: tentativas sem chave não gastam
  // o orçamento de quem tem chave.
  const global = checkRateLimit('leads-web:global', RATE_LIMIT_GLOBAL)
  if (!global.success) return rateLimitResponse(global)
  const perIp = checkRateLimit(`leads-web:ip:${clientIp(request)}`, RATE_LIMIT_PER_IP)
  if (!perIp.success) return rateLimitResponse(perIp)

  const raw = await request.text()
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const parsed = webLeadSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        // Só caminhos e mensagens, nunca os valores recebidos.
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      { status: 400 },
    )
  }

  try {
    const db = supabaseAdmin()
    const account = await resolveWebLeadAccount(db)
    if (!account) {
      return NextResponse.json({ error: 'not configured' }, { status: 503 })
    }

    const result = await processWebLead(db, account, parsed.data)
    if (result.background) after(result.background)

    if (result.outcome === 'duplicate') {
      return NextResponse.json({ ok: true, status: 'duplicate' }, { status: 200 })
    }
    if (result.outcome === 'invalid_phone') {
      return NextResponse.json(
        { ok: false, status: 'invalid_phone', error: 'Telefone inválido.' },
        { status: 422 },
      )
    }
    return NextResponse.json(
      { ok: true, status: result.templateStatus ?? 'pending' },
      { status: 200 },
    )
  } catch (err) {
    console.error('[leads web] erro inesperado:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
