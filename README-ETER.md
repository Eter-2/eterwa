# EterWA

Fork da Eter Growth de [wacrm](https://github.com/ArnasDon/wacrm) (MIT) —
CRM WhatsApp self-hostable em Next.js + Supabase. Objectivo: transformar
o `wacrm` num agente de IA de WhatsApp que qualifica leads e agenda
reuniões directamente no Google Calendar da conta.

- **Fork:** `Eter-2/eterwa` (org GitHub `Eter-2`)
- **Upstream:** `ArnasDon/wacrm` — remote `upstream`, nunca fazer push aqui
- **Branch de trabalho:** `feat/eter-agent`

## O que mudámos face ao upstream (Fase 1 — fundação)

Esta fase não adiciona lógica de negócio — só a base sobre a qual o
agente vai ser construído:

- `src/lib/calendar/date-resolver.ts` — resolutor determinístico de
  datas relativas em PT-PT ("amanhã", "próxima semana", "daqui a 5
  dias", "segunda-feira", "de manhã"/"de tarde", datas explícitas).
  Corre **antes** de qualquer chamada ao LLM ou a uma tool — o modelo
  nunca interpreta datas relativas sozinho. Timezone é sempre o da
  conta (`calendar_configs.timezone`), nunca UTC nem a tz do servidor.
  18 testes vitest em `date-resolver.test.ts`.
- `src/lib/ai/tools/schema.ts` — contrato JSON-Schema das 9 tools do
  agente (`check_availability`, `find_event`, `book_meeting`,
  `reschedule`, `cancel_booking`, `save_lead_qualification`,
  `notify_admin`, `escalate_to_human`, `send_reminder`). Só schemas —
  a implementação (tool-calling real nos providers OpenAI/Anthropic)
  é de uma fase seguinte.
- `supabase/migrations/037_eter_agent.sql` — **provisória.** Escrita
  seguindo as convenções Supabase/RLS do resto do repo (migrações
  029/030), mas a Eter Growth está a avaliar substituir Supabase por
  um Postgres interno próprio — ver `docs/eter-agent-config.md` e o
  relatório de desacoplamento do Supabase. Não assumir este schema
  como final.
- `docs/eter-agent-config.md` — variáveis de ambiente novas (Google
  OAuth para Calendar) que não puderam ir para `.env.local.example`
  por causa de uma guarda de segurança do harness sobre ficheiros
  `.env*`.

## Lead do site → template → demo ao vivo → reunião

Fluxo das landings da Vera (`lp-vera-whatsapp`, `lp-vera-linkedin`):
formulário → `POST /api/leads/web` → template `eter_demo_web_v1` no
WhatsApp da lead → a lead responde "Olá" → a Vera corre em **modo demo**
(simulação de atendimento, qualificação, marcação da reunião com o
Ricardo).

### Variáveis de ambiente

Vão para o `.env.local` do servidor (nunca para o repo). Nota: o
`.env.local.example` não pôde ser editado pelo harness (guarda sobre
ficheiros `.env*`); acrescentar `LEADS_WEB_KEY=` lá à mão.

| Variável | Obrigatória | Para quê |
|---|---|---|
| `LEADS_WEB_KEY` | sim | Chave partilhada com o servidor do site (header `X-Lead-Key`), mínimo 32 bytes. Sem ela, ou mais curta, o endpoint responde 503. `openssl rand -hex 32`. O site guarda o mesmo valor no `.env` do seu servidor. |
| `LEADS_WEB_ACCOUNT_ID` | não | Conta dona do número da Vera. Sem isto só é aceite se existir exactamente uma `whatsapp_config`. |
| `DEMO_MAX_REPLIES` | não | Tecto de respostas da IA numa conversa de demo (por omissão 40, independente do tecto da conta). Ao atingi-lo, a Vera avisa a lead e chama a equipa. |
| `DEMO_TEMPLATE_NAME` | não | Nome do template de abertura. Por omissão `eter_demo_web_v1`. |
| `TWENTY_PERSON_ORIGIN_FIELD` | não | Nome do campo da Person no Twenty onde gravar a origem `site_demo`. Sem isto a origem não vai para o Twenty (fica em `web_leads` e na conversa). |
| `MATTERMOST_WEBHOOK_URL`, `ai_configs.notify_phone_numbers` | já existem | Avisos da lead nova ao Ricardo (mesmo canal dos handoffs). |

Migração a aplicar **antes** do deploy: `supabase/migrations/060_site_demo.sql`
(tabela `web_leads` e coluna `conversations.demo_context`).

### Contrato do endpoint (para o site)

`POST https://eterwa.etergrowth.com/api/leads/web`, chamado pelo
**servidor** do site, nunca pelo browser (a chave não pode ir para o
cliente).

Headers: `Content-Type: application/json`, `X-Lead-Key: <LEADS_WEB_KEY>`.
O rate limit usa o IP que o nginx do EterWA vê (`X-Real-IP`, que o nginx
sobrescreve), nunca cabeçalhos do cliente: 30 pedidos/min por IP, 120/min
global, e 10 falhas de chave num minuto bloqueiam o IP (429). Tecto de
100 leads/24 h por conta e 1 por telefone/24 h.

```json
{
  "nome": "Duarte Silva",
  "telefone": "912 345 678",
  "email": "duarte@exemplo.pt",
  "empresa": "Plásticos do Norte",
  "n_comerciais": "3-5",
  "source": "lp-vera-whatsapp",
  "consentimento_whatsapp": true,
  "consentimento_texto": "Aceito ser contactado por WhatsApp sobre a demonstração da Vera.",
  "pagina_url": "https://etergrowth.com/agente-whatsapp",
  "user_agent": "<user agent do visitante>",
  "ip_visitante": "<ip do visitante>",
  "utm": { "utm_source": "linkedin", "utm_campaign": "vera" },
  "event_id": "evt_abc123"
}
```

- Obrigatórios: `nome`, `telefone`, `email`, `empresa`, `source`
  (`lp-vera-whatsapp` ou `lp-vera-linkedin`), `consentimento_whatsapp`
  (boolean, presente). Com `consentimento_whatsapp: true` são também
  obrigatórios `consentimento_texto` (o texto exacto da checkbox) e
  `pagina_url`; ficam guardados com a data, o `user_agent`, o
  `ip_visitante` (opcionais, enviados pelo servidor do site) e o IP do
  pedido, como prova de consentimento. Nenhum campo de texto pode ter
  quebras de linha nem caracteres de controlo (400). Opcionais: `n_comerciais` (texto, ex. `1-2`, `3-5`,
  `6-10`, `Mais de 10`), `utm` (até 20 chaves), `event_id`.
- Telefone: 9 dígitos portugueses ganham o indicativo 351; `+351...` e
  `00351...` também servem.
- Idempotência: o mesmo `event_id`, ou o mesmo telefone nas últimas 24 h,
  devolve `{"ok":true,"status":"duplicate"}` e não envia nada.

Respostas:

| HTTP | Corpo | Significa |
|---|---|---|
| 200 | `{"ok":true,"status":"sent"}` | Template enviado. |
| 200 | `{"ok":true,"status":"template_pendente"}` | Template ainda não aprovado pela Meta; reenvia sozinho (cron) quando for. |
| 200 | `{"ok":true,"status":"skipped_no_consent"}` | `consentimento_whatsapp: false`: registada, nada enviado, o Ricardo é avisado para contactar por email. |
| 200 | `{"ok":true,"status":"duplicate"}` | Já recebida. |
| 200 | `{"ok":true,"status":"skipped_existing_conversation"}` | O contacto já tem uma conversa que não é uma demo (ou tem agente humano): não se converte, a equipa é avisada. |
| 200 | `{"ok":true,"status":"failed"}` | Registada, mas o envio falhou (ver `web_leads.template_error`). |
| 400 | `{"error":"Validation failed","issues":[...]}` | Corpo inválido (só caminhos, nunca os valores). |
| 401 | | Chave em falta ou errada. |
| 413 | | Corpo > 8 KB. |
| 422 | `{"status":"invalid_phone"}` | Telefone inutilizável (registada, nada enviado). |
| 429 | | Rate limit, IP bloqueado por falhas de chave, ou tecto diário de leads. |
| 503 | | `LEADS_WEB_KEY` não definida ou conta não resolvida. |

### Template `eter_demo_web_v1`

Categoria MARKETING, `pt_PT`, botão QUICK_REPLY "Olá". Texto e payload em
`src/lib/meta/demo-template.ts` (editar o texto implica nova aprovação
da Meta). Submeter e consultar o estado: `scripts/submit-demo-template.ts`
(instruções no cabeçalho do ficheiro; `--submit` e `--status`).

### Modo demo da Vera

Conversas com `conversations.source = 'site_demo'` usam
`src/lib/ai/demo.ts` em vez do prompt comercial: não pergunta o nome,
pergunta sector/produto/tipo de pedido, faz a simulação (4 a 6
mensagens), qualifica a lead real (`save_demo_qualification`, guardado em
`conversations.demo_context`) e marca a reunião com
`check_commercial_availability` / `book_commercial_meeting` (a agenda
comercial já configurada). Tratamento por "tu", sem preços nem prazos
inventados, passa a humano se pedirem. O tecto de respostas da IA nestas
conversas é no mínimo 40.

### Como testar

```bash
npm ci
npx vitest run src/lib/meta/web-leads.test.ts src/lib/ai/demo.test.ts \
  src/app/api/leads/web/route.test.ts   # unitários e conversa simulada (LLM falso)
```

Teste real (só com OK do Ricardo, e apenas com o número dele): com a
migração aplicada, o branch em staging/produção e o template aprovado,

```bash
curl -s -X POST https://eterwa.etergrowth.com/api/leads/web \
  -H "Content-Type: application/json" -H "X-Lead-Key: $LEADS_WEB_KEY" \
  -d '{"nome":"Ricardo","telefone":"<número do Ricardo>","email":"ricardo@etershield.com","empresa":"Teste","source":"lp-vera-whatsapp","consentimento_whatsapp":true}'
```

(`LEADS_WEB_KEY` lida do `.env`, nunca escrita no comando.)

## O que ainda NÃO existe

1. Tool-calling real no LLM (hoje `src/lib/ai/generate.ts` só produz
   texto — os schemas em `tools/schema.ts` ainda não são chamados).
2. Qualquer integração real com o Google Calendar API (OAuth flow,
   criação/alteração/cancelamento de eventos).
3. Rubrica de qualificação de lead (o schema `lead_qualification` /
   `save_lead_qualification` existe, a lógica de pontuação não).
4. Decisão final sobre a camada de persistência (Supabase vs Postgres
   interno) — bloqueia finalizar a migração 037 e qualquer código que
   leia/escreva `calendar_configs`, `bookings`, `lead_qualification`.

## Arranque (herdado do upstream — Docker-first)

```bash
git clone git@github.com:Eter-2/eterwa.git
cd eterwa
cp .env.local.example .env.local   # preencher com valores reais
docker compose up
```

Ver `.env.local.example` para as variáveis obrigatórias (Supabase,
`ENCRYPTION_KEY`, `META_APP_SECRET`) e `docs/eter-agent-config.md` para
as variáveis novas do agente EterWA.
