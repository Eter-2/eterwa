// ============================================================
// lead-sanitize.ts — higiene de texto vindo do formulário do site
// (não confiável): é lido pelo modelo (prompt da demo), escrito em
// Mattermost e em logs. Tudo o que o visitante controla passa por aqui
// antes de sair para qualquer destes sítios.
// ============================================================

/** Caracteres de controlo (inclui CR, LF, TAB), DEL, C1 e os separadores
 *  de linha/parágrafo Unicode (U+2028 e U+2029). */
const INVISIBLE = [
  [0x2028, 0x2029], // separadores de linha/parágrafo
  [0x200b, 0x200f], // zero-width e marcas direccionais
  [0x202a, 0x202e], // embeddings/overrides bidi
  [0x2060, 0x2064], // word joiner e invisíveis
  [0x2066, 0x2069], // isolates bidi
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
]
  .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`)
  .join('')
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp(`[\\u0000-\\u001F\\u007F-\\u009F${INVISIBLE}]`)
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

/** JSON seguro para pôr dentro de um bloco delimitado por tags no prompt:
 *  < e > nunca aparecem em bruto, por isso o valor não consegue fechar o
 *  bloco (</dados_lead>) nem abrir outro. */
export function jsonForPromptBlock(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
}

/** Tira números de telefone e emails de texto livre (erros da Meta, logs). */
export function maskPii(text: string): string {
  return text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '***@***')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '***')
}
