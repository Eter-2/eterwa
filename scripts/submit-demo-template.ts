// ============================================================
// Submete (ou consulta) o template eter_demo_web_v1 na Meta e regista-o
// em `message_templates`. Reutiliza submitMessageTemplate, decrypt e
// buildDemoTemplateSubmitPayload; nunca imprime tokens.
//
//   node submit-demo-template.mjs            → dry-run: mostra o payload
//   node submit-demo-template.mjs --submit   → submete e grava a linha
//   node submit-demo-template.mjs --status   → pergunta o estado à Meta e
//                                              actualiza a linha local
//
// Precisa de NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e
// ENCRYPTION_KEY no ambiente (no servidor: --env-file=.env.local).
// Como o servidor não tem tsx, empacota-se com esbuild antes de correr:
//
//   npx esbuild scripts/submit-demo-template.ts --bundle --platform=node \
//     --format=esm --packages=external --outfile=dist/submit-demo-template.mjs
//
// (--packages=external: o node corre a partir de /opt/eterwa/app, onde
// já estão @supabase/supabase-js e as restantes dependências.)
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { META_API_BASE, submitMessageTemplate } from '@/lib/whatsapp/meta-api'
import {
  DEMO_TEMPLATE_BODY,
  DEMO_TEMPLATE_BUTTON,
  DEMO_TEMPLATE_EXAMPLE_NAME,
  DEMO_TEMPLATE_LANGUAGE,
  buildDemoTemplateSubmitPayload,
  demoTemplateName,
} from '@/lib/meta/demo-template'

const mode = process.argv.includes('--submit')
  ? 'submit'
  : process.argv.includes('--status')
    ? 'status'
    : 'dry-run'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Falta ${name} no ambiente.`)
    process.exit(1)
  }
  return value
}

async function main() {
  const name = demoTemplateName()
  const payload = buildDemoTemplateSubmitPayload(name)

  if (mode === 'dry-run') {
    console.log('Dry-run. Payload que seria submetido (nada foi enviado):')
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  const db = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  )
  const { data: configs, error: cfgErr } = await db
    .from('whatsapp_config')
    .select('account_id, user_id, waba_id, access_token')
  if (cfgErr) throw new Error(`whatsapp_config: ${cfgErr.message}`)
  if (!configs || configs.length !== 1) {
    throw new Error(`Esperava exactamente 1 whatsapp_config, encontrei ${configs?.length ?? 0}.`)
  }
  const cfg = configs[0] as {
    account_id: string
    user_id: string
    waba_id: string | null
    access_token: string
  }
  if (!cfg.waba_id) throw new Error('whatsapp_config sem waba_id.')
  const accessToken = decrypt(cfg.access_token)

  const { data: existing } = await db
    .from('message_templates')
    .select('id, status, meta_template_id')
    .eq('account_id', cfg.account_id)
    .eq('name', name)
    .eq('language', DEMO_TEMPLATE_LANGUAGE)
    .maybeSingle()

  if (mode === 'submit') {
    if (existing) {
      console.log(
        `Já existe localmente: ${name} (${existing.status}, id ${existing.meta_template_id}). Usa --status para actualizar.`,
      )
      return
    }
    const result = await submitMessageTemplate({ wabaId: cfg.waba_id, accessToken, payload })
    const { error } = await db.from('message_templates').upsert(
      {
        account_id: cfg.account_id,
        user_id: cfg.user_id,
        name,
        category: 'Marketing',
        language: DEMO_TEMPLATE_LANGUAGE,
        body_text: DEMO_TEMPLATE_BODY,
        buttons: [{ type: 'QUICK_REPLY', text: DEMO_TEMPLATE_BUTTON }],
        sample_values: { body: [DEMO_TEMPLATE_EXAMPLE_NAME] },
        status: result.status.toUpperCase(),
        meta_template_id: result.id,
        submission_error: null,
        last_submitted_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,name,language' },
    )
    if (error) console.error(`Submetido, mas falhou a gravar a linha local: ${error.message}`)
    console.log(`Submetido: ${name} | estado ${result.status} | id ${result.id} | categoria ${result.category ?? 'n/d'}`)
    return
  }

  // --status
  const url =
    `${META_API_BASE}/${cfg.waba_id}/message_templates?name=${encodeURIComponent(name)}` +
    '&fields=id,name,status,category,language,rejected_reason'
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Meta respondeu HTTP ${res.status}`)
  const body = (await res.json()) as {
    data?: { id: string; name: string; status: string; category: string; language: string; rejected_reason?: string }[]
  }
  const found = body.data?.find((t) => t.language === DEMO_TEMPLATE_LANGUAGE)
  if (!found) {
    console.log(`A Meta não conhece ${name} (${DEMO_TEMPLATE_LANGUAGE}).`)
    return
  }
  console.log(
    `Estado: ${found.status} | id ${found.id} | categoria ${found.category}` +
      (found.rejected_reason && found.rejected_reason !== 'NONE' ? ` | motivo ${found.rejected_reason}` : ''),
  )
  if (existing) {
    await db
      .from('message_templates')
      .update({
        status: found.status.toUpperCase(),
        meta_template_id: found.id,
        rejection_reason: found.rejected_reason && found.rejected_reason !== 'NONE' ? found.rejected_reason : null,
      })
      .eq('id', existing.id)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
