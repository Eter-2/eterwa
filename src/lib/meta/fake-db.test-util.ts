import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Supabase em memória para testes: tabelas como arrays de linhas e um
// query builder com os poucos operadores que web-leads.ts, demo.ts e o
// findExistingContact usam. Qualquer operador desconhecido lança, para
// uma query nova nunca passar despercebida num teste.
// ============================================================

type Row = Record<string, unknown>
type Filter = (row: Row) => boolean

export interface FakeDb {
  client: SupabaseClient
  tables: Record<string, Row[]>
}

let seq = 0

export function makeFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {
    web_leads: [],
    contacts: [],
    conversations: [],
    whatsapp_config: [],
    ...seed,
  }

  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' = 'select'
    let payload: Row = {}
    const filters: Filter[] = []
    let max = Infinity
    let orderBy: { col: string; asc: boolean } | null = null

    const run = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
      const rows = tables[table] ?? (tables[table] = [])
      if (op === 'insert') {
        if (table === 'web_leads' && payload.event_id) {
          const dup = rows.some(
            (r) => r.account_id === payload.account_id && r.event_id === payload.event_id,
          )
          if (dup) return { data: null, error: { code: '23505', message: 'duplicate key' } }
        }
        const now = new Date().toISOString()
        const row: Row = { id: `${table}-${++seq}`, created_at: now, updated_at: now, ...payload }
        if (table === 'web_leads') row.template_attempts ??= 0
        rows.push(row)
        return { data: [row], error: null }
      }
      let matched = rows.filter((r) => filters.every((f) => f(r)))
      if (op === 'update') {
        for (const r of matched) Object.assign(r, payload, { updated_at: new Date().toISOString() })
        return { data: matched, error: null }
      }
      if (orderBy) {
        const { col, asc } = orderBy
        matched = [...matched].sort((a, b) =>
          String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : String(a[col]) > String(b[col]) ? (asc ? 1 : -1) : 0,
        )
      }
      return { data: matched.slice(0, max), error: null }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b,
      insert: (p: Row) => {
        op = 'insert'
        payload = p
        return b
      },
      update: (p: Row) => {
        op = 'update'
        payload = p
        return b
      },
      eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), b),
      is: (col: string, val: unknown) => (filters.push((r) => (r[col] ?? null) === val), b),
      gte: (col: string, val: string) => (filters.push((r) => String(r[col]) >= val), b),
      lte: (col: string, val: string) => (filters.push((r) => String(r[col]) <= val), b),
      like: (col: string, pattern: string) => {
        const suffix = pattern.replace(/^%/, '')
        filters.push((r) => String(r[col] ?? '').endsWith(suffix))
        return b
      },
      order: (col: string, o: { ascending?: boolean } = {}) => {
        orderBy = { col, asc: o.ascending !== false }
        return b
      },
      limit: (n: number) => {
        max = n
        return b
      },
      maybeSingle: () => {
        const r = run()
        return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error })
      },
      single: () => {
        const r = run()
        return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error })
      },
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(ok, ko),
    }
    return b
  }

  return { client: { from: builder } as unknown as SupabaseClient, tables }
}
