// ============================================================
// demo-template.ts — template de WhatsApp que abre a janela de 24h
// quando alguém pede a demo da Vera nas landings (lp-vera-whatsapp /
// lp-vera-linkedin) e que dispara o MODO DEMO quando a pessoa responde
// (src/lib/ai/demo.ts).
//
// Corpo e botão aprovados pelo Ricardo em 08/10/2026. Qualquer
// alteração ao texto depois de submetido implica nova aprovação da Meta
// (10 edições/30 dias), por isso o texto vive só aqui.
//
// Nome sobreponível por env (DEMO_TEMPLATE_NAME), para testar com uma
// variante sem tocar no código; o corpo e o idioma ficam fixos.
// ============================================================

import type { MetaTemplateSubmitPayload } from '../whatsapp/template-components'

export const DEFAULT_DEMO_TEMPLATE_NAME = 'eter_demo_web_v1'
export const DEMO_TEMPLATE_LANGUAGE = 'pt_PT'

export const DEMO_TEMPLATE_BODY =
  'Olá {{1}}, é a Vera, da Eter Growth. Vi que pediste para falar connosco. Responde "Olá" e mostro-te ao vivo como atendo os pedidos dos teus clientes.'

export const DEMO_TEMPLATE_BUTTON = 'Olá'

/** Exemplo de {{1}} exigido pela Meta na submissão. */
export const DEMO_TEMPLATE_EXAMPLE_NAME = 'Duarte'

export function demoTemplateName(): string {
  return process.env.DEMO_TEMPLATE_NAME?.trim() || DEFAULT_DEMO_TEMPLATE_NAME
}

/**
 * Payload de POST /{waba_id}/message_templates para o template de
 * demo. Mesma forma de `buildLeadTemplateSubmitPayload`
 * (lead-templates.ts), com um único botão QUICK_REPLY.
 */
export function buildDemoTemplateSubmitPayload(
  name: string = demoTemplateName(),
): MetaTemplateSubmitPayload {
  return {
    name,
    category: 'MARKETING',
    language: DEMO_TEMPLATE_LANGUAGE,
    components: [
      {
        type: 'BODY',
        text: DEMO_TEMPLATE_BODY,
        example: { body_text: [[DEMO_TEMPLATE_EXAMPLE_NAME]] },
      },
      {
        type: 'BUTTONS',
        buttons: [{ type: 'QUICK_REPLY', text: DEMO_TEMPLATE_BUTTON }],
      },
    ],
  }
}
