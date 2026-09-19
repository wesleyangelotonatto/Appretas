# Secretária Virtual Iara — Configuração

## 1. Clonar e instalar

```bash
git clone https://github.com/wesleyangelotonatto/appretas.git secretaria-iara
cd secretaria-iara
npm install
cp .env.example .env
# Preencha o .env com as credenciais
```

## 2. Variáveis de ambiente (`.env`)

Consulte `.env.example` para a lista completa. Principais:

| Variável | Onde encontrar |
|---|---|
| `WASPEED_TOKEN` | Waspeed → API Keys |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `GROQ_API_KEY` | console.groq.com |
| `GOOGLE_CLIENT_EMAIL` | Google Service Account (projeto crm-automation) |
| `GOOGLE_PRIVATE_KEY` | idem |
| `GOOGLE_OAUTH_*` | Drive OAuth2 (projeto crm-automation) |
| `TRELLO_API_KEY/TOKEN` | https://trello.com/app-key |
| `TRELLO_BOARD_OPERACIONAL_ID` | URL do board: trello.com/b/**ID**/... |
| `TRELLO_BOARD_VENDAS_ID` | idem |
| `OPERATOR_PHONE` | Seu número: 554499XXXXXXX |
| `MODO_TREINO` | `true` nos primeiros 30 dias |

## 3. Inicializar banco

```bash
npm run db:migrate
```

## 4. Desenvolvimento local

```bash
npm run dev
# Painel em: http://localhost:3000
# Webhook em: POST http://localhost:3000/webhook
```

## 5. Deploy Railway

1. Conecte o repositório ao Railway
2. Configure todas as variáveis de ambiente no painel Railway
3. Adicione um volume em `/app/data` para persistência do SQLite
4. O Railway usa `railway.toml` automaticamente
5. URL pública do webhook: `https://SEU-APP.railway.app/webhook`

## 6. Configurar Waspeed webhook

No painel Waspeed, configure o webhook URL como:
```
https://SEU-APP.railway.app/webhook
```

## 7. Modo Treino (primeiros 30 dias)

Com `MODO_TREINO=true`, TODA resposta da Iara aparece no painel aguardando aprovação de Wesley antes de ser enviada. Use os botões **Aprovar e Enviar** ou **Editar** no painel.

Após ~200 aprovações consistentes, mude para `MODO_TREINO=false` no Railway.

## Estrutura dos módulos

```
src/
├── server.ts           — Express + Socket.IO + cron jobs
├── persona.ts          — Persona Iara, glossário jurídico, restrições
├── flow/
│   └── orchestrator.ts — Fluxo principal: classifica → consulta → responde
├── webhook/
│   └── waspeed.ts      — POST /webhook do Waspeed
├── classifier/
│   └── groq.ts         — Classificação (Llama 3.1 70B) + transcrição áudio (Whisper)
├── lookup/
│   ├── sheets.ts       — Lookup por telefone no Google Sheets
│   └── trello.ts       — Lookup por telefone no Trello
├── responder/
│   ├── claude.ts       — Redação (Claude Sonnet) + parser de comandos
│   └── send.ts         — Envio via Waspeed (classic Wascript API)
├── integrations/
│   ├── djen.ts         — PJe Comunica API + cache SQLite 7 dias
│   ├── trello.ts       — Lê Operacional + escreve Vendas/Leads
│   └── drive.ts        — Google Drive OAuth2, pasta por contato
├── cron/
│   ├── audiencias.ts   — 3 alertas de audiência (2º sexta, 3º véspera)
│   ├── prazos.ts       — Aviso no dia do prazo
│   └── followups.ts    — Follow-ups agendados
├── commands/
│   └── router.ts       — REST API do painel: /command, /command/approve, etc.
└── memory/
    ├── db.ts           — SQLite: sessões, histórico, blacklist, follow-ups
    └── migrate.ts      — Cria todas as tabelas
public/
└── index.html          — Painel 3 colunas (Socket.IO client)
```
