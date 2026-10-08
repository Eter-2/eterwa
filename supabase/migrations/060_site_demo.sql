-- ============================================================
-- 060_site_demo.sql — lead do site (landings da Vera) → template →
-- demo ao vivo no WhatsApp → qualificação → reunião.
--
-- Contexto: as landings lp-vera-whatsapp e lp-vera-linkedin enviam o
-- formulário para POST /api/leads/web. O EterWA cria/reaproveita o
-- contacto e a conversa (`conversations.source = 'site_demo'`), envia o
-- template `eter_demo_web_v1` e, quando a pessoa responde, a Vera corre
-- em MODO DEMO (src/lib/ai/demo.ts).
--
-- `web_leads` — uma linha por pedido do site, com o estado do envio do
-- template (mesmo desenho de `meta_leads`, migração 059). O estado
-- `template_pendente` é reprocessado pelo cron do agente
-- (/api/eter-agent/cron) assim que o template estiver aprovado.
--
-- `conversations.demo_context` — metadados da lead e da demo (empresa,
-- origem, nº de comerciais, utm, sector/produto/tipo de pedido,
-- qualificação). Fundido por save_demo_qualification.
--
-- Idempotente, seguro correr mais do que uma vez. APLICAR ANTES de
-- fazer deploy do código que lê estas colunas.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS demo_context jsonb;

CREATE TABLE IF NOT EXISTS web_leads (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Origem: 'lp-vera-whatsapp' | 'lp-vera-linkedin'.
  source                  text NOT NULL,
  -- event_id enviado pelo site (dedupe do browser/pixel). Único por conta.
  event_id                text,
  nome                    text NOT NULL,
  -- Telefone tal como enviado, e normalizado (só dígitos) para dedupe.
  telefone_raw            text,
  telefone                text,
  email                   text,
  empresa                 text,
  n_comerciais            text,
  utm                     jsonb,
  consentimento_whatsapp  boolean NOT NULL DEFAULT false,
  contact_id              uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id         uuid REFERENCES conversations(id) ON DELETE SET NULL,
  -- Twenty person id (texto, sem FK, mesmo critério de meta_leads).
  crm_person_id           text,
  -- pending             — registada, envio ainda não tentado/terminado
  -- sent                — template enviado à Meta com sucesso
  -- template_pendente   — template ainda não aprovado/encontrado; reenvia o cron
  -- failed              — erro inesperado no envio (ver template_error)
  -- skipped_no_consent  — sem consentimento WhatsApp
  -- skipped_no_phone    — telefone ausente ou inválido
  template_status         text NOT NULL DEFAULT 'pending'
                             CHECK (template_status IN (
                               'pending', 'sent', 'template_pendente',
                               'failed', 'skipped_no_consent', 'skipped_no_phone'
                             )),
  template_name           text,
  template_message_id     text,
  template_error          text,
  template_attempts       integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_web_leads_event_id
  ON web_leads (account_id, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_web_leads_account_id ON web_leads (account_id);
CREATE INDEX IF NOT EXISTS idx_web_leads_telefone_created
  ON web_leads (account_id, telefone, created_at DESC) WHERE telefone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_web_leads_template_status
  ON web_leads (template_status) WHERE template_status = 'template_pendente';

ALTER TABLE web_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS web_leads_select ON web_leads;
CREATE POLICY web_leads_select ON web_leads FOR SELECT
  USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION public.update_web_leads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS web_leads_updated_at ON web_leads;
CREATE TRIGGER web_leads_updated_at
  BEFORE UPDATE ON web_leads
  FOR EACH ROW
  EXECUTE FUNCTION public.update_web_leads_updated_at();
