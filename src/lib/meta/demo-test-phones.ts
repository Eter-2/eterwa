// ============================================================
// demo-test-phones.ts — números de teste da demo (env DEMO_TEST_PHONES,
// lista separada por vírgulas). Só para estes números:
//   - o dedupe de 24 h por telefone não se aplica (dá para repetir);
//   - uma conversa anterior com histórico é ARQUIVADA (nunca apagada) e
//     nasce uma conversa nova em modo demo;
//   - a classificação de equipa (team_phone_numbers) é ignorada e a Vera
//     responde em modo demo (src/lib/ai/auto-reply.ts).
// Sem a env, nada disto acontece. Comparação pelos últimos 9 dígitos.
// ============================================================

export function demoTestPhones(): string[] {
  return (process.env.DEMO_TEST_PHONES ?? '')
    .split(',')
    .map((p) => p.replace(/\D/g, ''))
    .filter((p) => p.length >= 9)
    .map((p) => p.slice(-9))
}

export function isDemoTestPhone(phone: string | null | undefined): boolean {
  if (!phone) return false
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 9) return false
  return demoTestPhones().includes(digits.slice(-9))
}
