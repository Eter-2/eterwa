// ============================================================
// lead-sanitize.ts — higiene de texto vindo do formulário do site
// (não confiável): é lido pelo modelo (prompt da demo), escrito em
// Mattermost e em logs. Tudo o que o visitante controla passa por aqui
// antes de sair para qualquer destes sítios.
// ============================================================

/** Caracteres de controlo (inclui CR, LF, TAB), DEL, C1 e os separadores
 *  de linha/parágrafo Unicode (U+2028 e U+2029). */
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029)
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp(`[\\u0000-\\u001F\\u007F-\\u009F${LINE_SEPARATORS}]`)
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CHARS.source, 'g')

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value)
}

/** Uma linha só: controlo → espaço, espaços colapsados, truncado. */
export function cleanField(value: string | null | undefined, max = 80): string {
  const collapsed = (value ?? '')
    .replace(CONTROL_CHARS_GLOBAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed
}

/** Neutraliza markdown e @menções (Mattermost) num campo já limpo. */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/([\\`*_~[\]()<>#|!{}])/g, '\\$1')
    .replace(/@/g, '＠')
    .replace(/:/g, '∶')
}

/** Campo de lead pronto para uma notificação: limpo, truncado, escapado. */
export function safeForNotification(value: string | null | undefined, max = 80): string {
  return escapeMarkdown(cleanField(value, max))
}

/** Tira números de telefone e emails de texto livre (erros da Meta, logs). */
export function maskPii(text: string): string {
  return text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '***@***')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '***')
}
