import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  renderTemplateBody,
  templateBodyParams,
  templateMessageText,
  templateFallbackText,
  fetchAndStoreTemplate,
  ensureTemplateRow,
} from './template-render'

const BODY =
  'Olá {{1}}, sou a Vera. Quer retomar a conversa sobre o AI SDR na {{2}}?'

describe('renderTemplateBody', () => {
  it('substitui {{N}} pelos params', () => {
    expect(renderTemplateBody(BODY, ['Bruno', 'Magnusberry'])).toBe(
      'Olá Bruno, sou a Vera. Quer retomar a conversa sobre o AI SDR na Magnusberry?',
    )
  })
  it('mantém {{N}} quando falta o param (não inventa)', () => {
    expect(renderTemplateBody(BODY, ['Bruno'])).toContain('{{2}}')
  })
})

describe('templateBodyParams', () => {
  it('prefere messageParams.body', () => {
    expect(templateBodyParams({ body: ['a', 'b'] }, ['x'])).toEqual(['a', 'b'])
  })
  it('cai para os params legacy', () => {
    expect(templateBodyParams(undefined, ['x'])).toEqual(['x'])
    expect(templateBodyParams(null)).toEqual([])
  })
})

describe('templateMessageText', () => {
  it('renderiza o corpo do template', () => {
    expect(templateMessageText({ body_text: BODY }, 'v2', ['Bruno', 'Magnusberry'])).toMatch(
      /^Olá Bruno,.*na Magnusberry\?$/,
    )
  })
  it('usa o fallback [template: nome] sem corpo', () => {
    expect(templateMessageText(null, 'eter_x', [])).toBe(templateFallbackText('eter_x'))
    expect(templateFallbackText('eter_x')).toBe('[template: eter_x]')
  })
})

function dbWithLocal(local: unknown, insertResult?: { data: unknown; error: unknown }) {
  const inserts: unknown[] = []
  const db = {
    from: () => ({
      select: () => {
        const q: Record<string, unknown> = {}
        q.eq = () => q
        q.maybeSingle = () => Promise.resolve({ data: local, error: null })
        return q
      },
      insert: (row: unknown) => {
        inserts.push(row)
        return {
          select: () => ({
            single: () =>
              Promise.resolve(insertResult ?? { data: { ...(row as object), id: 'tpl-1', created_at: 'x' }, error: null }),
          }),
        }
      },
    }),
  } as unknown as SupabaseClient
  return { db, inserts }
}

const META = {
  id: '123',
  name: 'v2',
  language: 'pt_PT',
  status: 'APPROVED',
  category: 'MARKETING',
  components: [{ type: 'BODY', text: BODY }],
}

describe('fetchAndStoreTemplate / ensureTemplateRow', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [META] }), { status: 200 })),
    ) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  const args = {
    accountId: 'acc',
    userId: 'user',
    wabaId: 'waba',
    accessToken: 'tok',
    name: 'v2',
    language: 'pt_PT',
  }

  it('vai à Graph API e grava a linha quando não existe localmente', async () => {
    const { db, inserts } = dbWithLocal(null)
    const row = await fetchAndStoreTemplate(db, args)
    expect(row?.body_text).toBe(BODY)
    expect(inserts).toHaveLength(1)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('devolve o corpo mesmo que a gravação falhe (ex.: RLS)', async () => {
    const { db } = dbWithLocal(null, { data: null, error: { message: 'rls' } })
    const row = await fetchAndStoreTemplate(db, args)
    expect(row?.body_text).toBe(BODY)
  })

  it('devolve null quando a Graph API falha (fallback fica a cargo de quem chama)', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response('{}', { status: 500 })),
    ) as unknown as typeof fetch
    const { db } = dbWithLocal(null)
    expect(await fetchAndStoreTemplate(db, args)).toBeNull()
  })

  it('ensureTemplateRow usa a linha local sem chamar a Graph API', async () => {
    const local = { id: 't', user_id: 'u', name: 'v2', body_text: BODY }
    const { db } = dbWithLocal(local)
    expect(await ensureTemplateRow(db, args)).toEqual(local)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
