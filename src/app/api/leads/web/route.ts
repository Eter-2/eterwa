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
const RATE_LIMIT_PER_IP = { limit: 30, windowMs: 60_000 }
const RATE_LIMIT_GLOBAL = { limit: 120, windowMs: 60_000 }

function keyMatches(supplied: string, expected: string): boolean {
  // Hash dos dois lados: tempo constante e comprimentos iguais, sem
  // revelar o tamanho da chave.
  const a = createHash('sha256').update(supplied).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Falhas de autenticação por IP: depois de 10 em 1 minuto o IP fica
 *  bloqueado (429) até a janela fechar, mesmo com a chave certa. */
const AUTH_FAIL_LIMIT = 10
const AUTH_FAIL_WINDOW_MS = 60_000
const authFailures = new Map<string, { count: number; resetAt: number }>()

function isAuthBlocked(ip: string, now = Date.now()): boolean {
  const entry = authFailures.get(ip)
  if (!entry || entry.resetAt <= now) return false
  return entry.count >= AUTH_FAIL_LIMIT
}

function recordAuthFailure(ip: string, now = Date.now()): void {
  if (authFailures.size > 5000) {
    for (const [k, v] of authFailures) if (v.resetAt <= now) authFailures.delete(k)
  }
  const entry = authFailures.get(ip)
  if (!entry || entry.resetAt <= now) {
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS })
  } else {
    entry.count += 1
  }
}

export function __resetAuthFailuresForTests() {
  authFailures.clear()
}

/**
 * IP do cliente que o nginx viu. O nginx à frente do EterWA
 * (/etc/nginx/conf.d/eterwa.conf) SOBRESCREVE `X-Real-IP` com
 * `$remote_addr`, por isso o cliente não o consegue forjar. Sem ele
 * (ex.: testes), usa o ÚLTIMO salto de `X-Forwarded-For` (o que o
 * nginx acrescentou), nunca o primeiro, que é controlado pelo cliente.
 */
function clientIp(request: Request): string {
  const real = request.headers.get('x-real-ip')?.trim()
  if (real) return real
  const hops = request.headers.get('x-forwarded-for')?.split(',')
  const last = hops?.[hops.length - 1]?.trim()
  return last || 'unknown'
}

/** A chave tem de ter pelo menos 32 bytes (openssl rand -hex 32 dá 64). */
const MIN_KEY_BYTES = 32

export async function POST(request: Request) {
  const expectedKey = process.env.LEADS_WEB_KEY
  if (!expectedKey || Buffer.byteLength(expectedKey) < MIN_KEY_BYTES) {
    console.error(
      '[leads web] LEADS_WEB_KEY em falta ou com menos de 32 bytes, a recusar pedidos.',
    )
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  const ip = clientIp(request)
  if (isAuthBlocked(ip)) {
    return NextResponse.json(
      { error: 'Too many failed attempts' },
      { status: 429, headers: { 'Retry-After': '60' } },
    )
  }

  const supplied = request.headers.get('x-lead-key') ?? ''
  if (!supplied || !keyMatches(supplied, expectedKey)) {
    recordAuthFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limit depois da autenticação: tentativas sem chave não gastam
  // o orçamento de quem tem chave.
  const global = checkRateLimit('leads-web:global', RATE_LIMIT_GLOBAL)
  if (!global.success) return rateLimitResponse(global)
  const perIp = checkRateLimit(`leads-web:ip:${ip}`, RATE_LIMIT_PER_IP)
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

    const result = await processWebLead(db, account, parsed.data, new Date(), {
      requestIp: ip === 'unknown' ? null : ip,
    })
    if (result.background) after(result.background)

    if (result.outcome === 'duplicate') {
      return NextResponse.json({ ok: true, status: 'duplicate' }, { status: 200 })
    }
    if (result.outcome === 'rate_limited') {
      return NextResponse.json(
        { ok: false, status: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': '3600' } },
      )
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
