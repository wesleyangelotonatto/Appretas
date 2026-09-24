import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DATABASE_URL || './data/iara.db';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('Banco não inicializado');
  return _db;
}

export async function initDb(): Promise<void> {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      phone TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      status TEXT DEFAULT 'ativo',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      body TEXT NOT NULL,
      media_url TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS pending_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      draft TEXT NOT NULL,
      context TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      sent INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS follow_ups_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      next_send_at INTEGER NOT NULL,
      recurrence_days INTEGER DEFAULT 0,
      stop_condition TEXT DEFAULT 'manual',
      stop_date INTEGER,
      status TEXT DEFAULT 'ativo',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      phone TEXT PRIMARY KEY,
      reason TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS contact_instructions (
      phone TEXT PRIMARY KEY,
      instruction TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS group_permissions (
      group_id TEXT PRIMARY KEY,
      group_name TEXT,
      active INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    -- Banco apartado de calibração. Enquanto o modo calibragem está ligado, NADA
    -- sai para o cliente: toda resposta que teria sido enviada é registrada aqui,
    -- junto do que a IA redigiu e do que Wesley deixou depois de editar. Serve só
    -- para acertar o tom e o conteúdo do atendimento; não é histórico de conversa.
    CREATE TABLE IF NOT EXISTS treinamento (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      tipo TEXT,              -- 'rascunho' (resposta da IA revisada) | 'automatica' (aviso do sistema)
      contexto TEXT,          -- o que o cliente disse / contexto da resposta
      texto_original TEXT,    -- o que a IA redigiu
      texto_final TEXT,       -- o que ficou depois da edição de Wesley
      editado INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );

    -- Avisos de audiência e prazo aguardando confirmação de Wesley. Nada é
    -- enviado sem que ele escolha a data correta: as fontes do card (vencimento,
    -- descrição, comentário, checklist) divergem com frequência, e quem decide
    -- qual vale é ele. datas_json guarda todas as datas achadas, com a origem.
    CREATE TABLE IF NOT EXISTS avisos_pendentes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT,                 -- 'audiencia' | 'prazo'
      card_id TEXT,
      card_nome TEXT,
      processo TEXT,
      phone TEXT,
      nome TEXT,
      datas_json TEXT,           -- todas as datas encontradas, com origem
      data_escolhida TEXT,       -- a que Wesley confirmou
      mensagem TEXT,
      status TEXT DEFAULT 'pendente',   -- pendente | enviado | descartado
      cadastrado INTEGER DEFAULT 1,     -- 0 = processo não está na planilha
      partes TEXT,                      -- "Fulano x Beltrano", tirado do card
      juizo TEXT,                       -- vara/comarca, quando o card informa
      momento TEXT DEFAULT 'dia',       -- novo | semana | vespera (audiência) | dia (prazo)
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(card_id, tipo, momento)
    );

    -- Contato do cliente por processo, preenchido por Wesley na tela de avisos.
    -- Muitos processos do Trello não estão na planilha; sem isso ele teria de
    -- digitar nome e telefone de novo a cada varredura. A chave é o número do
    -- processo quando existe; senão, o próprio card (multa, recurso sem número).
    CREATE TABLE IF NOT EXISTS contatos_processo (
      chave TEXT PRIMARY KEY,
      processo TEXT,
      card_id TEXT,
      nome TEXT,
      phone TEXT,
      partes TEXT,      -- nome das partes, como Wesley corrigiu
      juizo TEXT,       -- vara/comarca, como Wesley corrigiu
      posicao TEXT,     -- posição do cliente: autor | réu | outro
      updated_at INTEGER DEFAULT (unixepoch())
    );

    -- Janela de agrupamento de mensagens do cliente. Ficava só na memória do
    -- processo, e cada reinício (deploy) apagava as janelas abertas: as mensagens
    -- continuavam salvas, mas nenhuma resposta era redigida — foi o que fez os
    -- rascunhos sumirem numa sequência de seis deploys em uma hora. Em banco,
    -- a janela sobrevive ao reinício e é retomada pela verificação periódica.
    CREATE TABLE IF NOT EXISTS janelas_resposta (
      phone TEXT PRIMARY KEY,
      textos TEXT,
      wa_name TEXT,
      ultima_at INTEGER DEFAULT (unixepoch())
    );

    -- Quais cards já foram vistos em cada lista, para saber quando um é NOVO —
    -- é o gatilho do primeiro aviso de audiência
    CREATE TABLE IF NOT EXISTS cards_vistos (
      card_id TEXT,
      tipo TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(card_id, tipo)
    );

    -- Que tipo de mensagem pronta já foi dita a cada contato. Sem isso a mesma
    -- frase (saudação, pedido dos dados do caso, aviso de cunho pessoal) saía a
    -- cada mensagem recebida, o que deixa o atendimento repetitivo e robótico.
    CREATE TABLE IF NOT EXISTS tipos_enviados (
      phone TEXT,
      tipo TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_tipos_enviados ON tipos_enviados(phone, tipo, created_at);

    -- Identificadores das mensagens já processadas. O Waspeed entrega o mesmo
    -- evento mais de uma vez (observado 2x e até 4x, com microssegundos de
    -- diferença), o que fazia o cliente receber a mesma resposta repetida.
    CREATE TABLE IF NOT EXISTS eventos_processados (
      event_id TEXT PRIMARY KEY,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      original TEXT NOT NULL,
      corrected TEXT NOT NULL,
      context TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    -- Controle do aviso de ausência: sent_date (YYYY-MM-DD) impede reenvio no mesmo dia;
    -- pending=1 marca contato que mandou mensagem fora da janela 07h-22h, aguardando a próxima abertura
    CREATE TABLE IF NOT EXISTS ausencia_notices (
      phone TEXT PRIMARY KEY,
      sent_date TEXT,
      pending INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_follow_ups_scheduled ON follow_ups(scheduled_at, sent);
    CREATE INDEX IF NOT EXISTS idx_fup2_next ON follow_ups_v2(next_send_at, status);
  `);

  // CREATE TABLE IF NOT EXISTS não altera tabela que já existe: uma coluna nova
  // só entra por ALTER. Sem isso, um banco criado por uma versão anterior fica
  // sem a coluna e toda gravação falha ("has no column named ...").
  // A recriação da tabela vem PRIMEIRO: ela reconstrói o esquema inteiro, então
  // acrescentar colunas antes fazia a coluna nova ser descartada na recriação
  migrarAvisosParaMomento();
  garantirColuna('avisos_pendentes', 'cadastrado', 'INTEGER DEFAULT 1');
  garantirColuna('avisos_pendentes', 'partes', 'TEXT');
  garantirColuna('avisos_pendentes', 'juizo', 'TEXT');
  garantirColuna('avisos_pendentes', 'posicao', 'TEXT');
  garantirColuna('contatos_processo', 'partes', 'TEXT');
  garantirColuna('contatos_processo', 'juizo', 'TEXT');
  garantirColuna('contatos_processo', 'posicao', 'TEXT');

  limparNomesContaminados();
  console.log('[db] banco inicializado:', DB_PATH);
}

// Corrige sessões salvas antes da correção do lookup do Trello, que armazenaram
// o título do card (ex: "REQUERIMENTO... ESPÓLIO DE...") como nome do contato.
// Reseta para o telefone; o nome correto do WhatsApp será aplicado na próxima mensagem.
function limparNomesContaminados() {
  const TITULO_CASO_RE = /processo|requerimento|apresenta[cç][aã]o|esp[oó]lio|execu[cç][aã]o|embargos|a[cç][aã]o\b|mandado|recurso|apela[cç][aã]o|invent[aá]rio|cumprimento de senten[cç]a|habilita[cç][aã]o| - | x /i;
  const sessions = getDb().prepare('SELECT phone, name FROM sessions').all() as Array<{ phone: string; name: string | null }>;
  let corrigidos = 0;
  for (const s of sessions) {
    if (s.name && (TITULO_CASO_RE.test(s.name) || /\d{4,}/.test(s.name) || s.name.length > 60)) {
      getDb().prepare('UPDATE sessions SET name = ? WHERE phone = ?').run(s.phone, s.phone);
      corrigidos++;
    }
  }
  if (corrigidos > 0) console.log(`[db] ${corrigidos} nome(s) de contato contaminado(s) por título de caso foram corrigidos`);
}

export function getSession(phone: string) {
  return getDb().prepare('SELECT * FROM sessions WHERE phone = ?').get(phone) as any;
}

// Colunas que upsertSession pode escrever — protege contra injeção via nomes de coluna
// caso algum chamador futuro derive as chaves de dados externos (payload de webhook, etc.)
const SESSION_COLUNAS_PERMITIDAS = new Set(['name', 'type', 'status']);

export function upsertSession(phone: string, data: Record<string, any>) {
  const chaves = Object.keys(data);
  const chavesInvalidas = chaves.filter(k => !SESSION_COLUNAS_PERMITIDAS.has(k));
  if (chavesInvalidas.length > 0) {
    throw new Error(`upsertSession: coluna(s) não permitida(s): ${chavesInvalidas.join(', ')}`);
  }

  const existing = getSession(phone);
  if (existing) {
    const sets = chaves.map(k => `${k} = ?`).join(', ');
    getDb().prepare(`UPDATE sessions SET ${sets}, updated_at = unixepoch() WHERE phone = ?`)
      .run(...Object.values(data), phone);
  } else {
    getDb().prepare(
      `INSERT INTO sessions (phone, ${chaves.join(', ')}) VALUES (?, ${chaves.map(() => '?').join(', ')})`
    ).run(phone, ...Object.values(data));
  }
}

export function saveMessage(phone: string, role: 'client' | 'iara' | 'wesley', body: string, mediaUrl?: string) {
  getDb().prepare('INSERT INTO messages (phone, role, body, media_url) VALUES (?, ?, ?, ?)')
    .run(phone, role, body, mediaUrl || null);
}

export function getHistory(phone: string, days = 90) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return getDb().prepare('SELECT * FROM messages WHERE phone = ? AND created_at > ? ORDER BY created_at').all(phone, since) as any[];
}

// Lista sessões ativas dos últimos N dias, com o histórico de mensagens de cada uma,
// para reconstruir o painel após um refresh (F5) sem perder conversas em andamento
export function getActiveConversations(days = 7) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const sessions = getDb().prepare('SELECT * FROM sessions WHERE updated_at > ? ORDER BY updated_at DESC').all(since) as any[];
  return sessions.map(s => ({
    ...s,
    messages: getDb().prepare('SELECT role, body, media_url as mediaUrl, created_at as timestamp FROM messages WHERE phone = ? AND created_at > ? ORDER BY created_at')
      .all(s.phone, since) as any[],
  }));
}

export function savePendingApproval(phone: string, draft: string, context: string) {
  return (getDb().prepare('INSERT INTO pending_approvals (phone, draft, context) VALUES (?, ?, ?)')
    .run(phone, draft, context)).lastInsertRowid;
}

// Junta o nome e o tipo do contato: revisar um rascunho olhando só para o
// número não diz a quem se está respondendo nem em que contexto
export function getPendingApprovals() {
  return getDb().prepare(`
    SELECT p.*, s.name AS nome, s.type AS tipo_contato
    FROM pending_approvals p
    LEFT JOIN sessions s ON s.phone = p.phone
    ORDER BY p.created_at
  `).all() as any[];
}

export function deletePendingApproval(id: number) {
  getDb().prepare('DELETE FROM pending_approvals WHERE id = ?').run(id);
}

// Descarta a fila inteira de uma vez. Retorna quantos rascunhos foram removidos.
export function deleteAllPendingApprovals(): number {
  return getDb().prepare('DELETE FROM pending_approvals').run().changes;
}

export function saveCorrection(phone: string, original: string, corrected: string, context?: string) {
  getDb().prepare('INSERT INTO corrections (phone, original, corrected, context) VALUES (?, ?, ?, ?)')
    .run(phone, original, corrected, context || null);
}

// Correções distintas, da mais recente para a mais antiga. Agrupa pares iguais:
// a mesma correção feita várias vezes é uma lição só, e sem isso ela ocupava
// várias vagas da janela, deixando de fora lições diferentes.
export function getRecentCorrections(limit = 20): Array<{ original: string; corrected: string }> {
  return getDb().prepare(`
    SELECT original, corrected, MAX(created_at) AS ts
    FROM corrections
    GROUP BY original, corrected
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit) as any[];
}

// Correções com o contato identificado, para a tela de revisão
export function getCorrectionsComContato(limit = 50): any[] {
  return getDb().prepare(`
    SELECT c.phone, c.original, c.corrected, c.context, c.created_at,
           s.name AS nome, s.type AS tipo_contato
    FROM corrections c
    LEFT JOIN sessions s ON s.phone = c.phone
    ORDER BY c.created_at DESC
    LIMIT ?
  `).all(limit) as any[];
}

export function getAusenciaNotice(phone: string): { phone: string; sent_date: string | null; pending: number } | undefined {
  return getDb().prepare('SELECT * FROM ausencia_notices WHERE phone = ?').get(phone) as any;
}

// ─── Banco de calibração (modo treinamento sem envio) ──────────────────────────

export function salvarTreinamento(dados: {
  phone: string;
  tipo: 'rascunho' | 'automatica';
  contexto?: string | null;
  textoOriginal: string;
  textoFinal: string;
}): number {
  const r = getDb().prepare(`
    INSERT INTO treinamento (phone, tipo, contexto, texto_original, texto_final, editado)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    dados.phone,
    dados.tipo,
    dados.contexto ?? null,
    dados.textoOriginal,
    dados.textoFinal,
    dados.textoOriginal !== dados.textoFinal ? 1 : 0
  );
  return Number(r.lastInsertRowid);
}

export function listarTreinamento(limit = 200): any[] {
  return getDb().prepare('SELECT * FROM treinamento ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as any[];
}

export function contarTreinamento(): { total: number; editados: number } {
  return getDb().prepare(
    'SELECT COUNT(*) AS total, COALESCE(SUM(editado), 0) AS editados FROM treinamento'
  ).get() as any;
}

export function limparTreinamento(): number {
  return getDb().prepare('DELETE FROM treinamento').run().changes;
}

// ─── Avisos de audiência e prazo aguardando confirmação ───────────────────────

// Uma mensagem pronta do mesmo tipo já foi dita a este contato há pouco?
export function jaEnviouTipo(phone: string, tipo: string, horas = 24): boolean {
  const limite = Math.floor(Date.now() / 1000) - horas * 3600;
  const r = getDb().prepare(
    'SELECT 1 FROM tipos_enviados WHERE phone = ? AND tipo = ? AND created_at > ? LIMIT 1'
  ).get(phone, tipo, limite);
  return !!r;
}

export function registrarTipoEnviado(phone: string, tipo: string) {
  getDb().prepare('INSERT INTO tipos_enviados (phone, tipo) VALUES (?, ?)').run(phone, tipo);
}

// A tabela antiga tinha UNIQUE(card_id, tipo), o que permitia um aviso por card.
// Uma audiência agora gera três (ao entrar na lista, uma semana antes e na
// véspera), então a chave passa a incluir o momento. Alterar UNIQUE no SQLite
// exige recriar a tabela; os avisos existentes são preservados.
function migrarAvisosParaMomento() {
  try {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(avisos_pendentes)').all() as any[];
    if (!cols.length || cols.some(c => c.name === 'momento')) return;

    db.exec(`
      ALTER TABLE avisos_pendentes RENAME TO avisos_pendentes_antiga;
      CREATE TABLE avisos_pendentes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo TEXT, card_id TEXT, card_nome TEXT, processo TEXT,
        phone TEXT, nome TEXT, datas_json TEXT, data_escolhida TEXT,
        mensagem TEXT, status TEXT DEFAULT 'pendente',
        cadastrado INTEGER DEFAULT 1, partes TEXT, juizo TEXT, posicao TEXT,
        momento TEXT DEFAULT 'dia',
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(card_id, tipo, momento)
      );
      INSERT INTO avisos_pendentes
        (id, tipo, card_id, card_nome, processo, phone, nome, datas_json,
         data_escolhida, mensagem, status, cadastrado, partes, juizo, posicao, momento, created_at)
      SELECT id, tipo, card_id, card_nome, processo, phone, nome, datas_json,
             data_escolhida, mensagem, status, cadastrado, partes, juizo, '',
             CASE WHEN tipo = 'prazo' THEN 'dia' ELSE 'novo' END, created_at
      FROM avisos_pendentes_antiga;
      DROP TABLE avisos_pendentes_antiga;
    `);
    console.log('[db] avisos_pendentes migrada para chave por momento');
  } catch (err) {
    console.error('[db] falha ao migrar avisos_pendentes:', err);
  }
}

// ─── Contatos por processo, aprendidos na tela de avisos ──────────────────────

// Chave: o número do processo quando existe; senão o card (multa, recurso sem número)
export function chaveContato(processo: string, cardId: string): string {
  const p = String(processo || '').replace(/[^0-9]/g, '');
  return p.length >= 15 ? p : `card:${cardId}`;
}

export interface ContatoProcesso {
  nome: string; phone: string; partes: string; juizo: string; posicao: string;
}

// Guarda TUDO que Wesley corrigiu para aquele processo — nome, destinatário,
// partes, juízo e posição. Na próxima varredura esses valores voltam prontos,
// em vez de o sistema reextrair do card e desfazer a correção. Campo vazio não
// apaga o que já estava guardado.
export function salvarContatoProcesso(dados: {
  processo: string; cardId: string; nome?: string; phone?: string;
  partes?: string; juizo?: string; posicao?: string;
}) {
  const chave = chaveContato(dados.processo, dados.cardId);
  const phone = String(dados.phone || '').replace(/[^0-9]/g, '');
  const algo = dados.nome || phone || dados.partes || dados.juizo || dados.posicao;
  if (!chave || !algo) return;
  getDb().prepare(`
    INSERT INTO contatos_processo (chave, processo, card_id, nome, phone, partes, juizo, posicao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chave) DO UPDATE SET
      nome    = COALESCE(NULLIF(excluded.nome, ''),    contatos_processo.nome),
      phone   = COALESCE(NULLIF(excluded.phone, ''),   contatos_processo.phone),
      partes  = COALESCE(NULLIF(excluded.partes, ''),  contatos_processo.partes),
      juizo   = COALESCE(NULLIF(excluded.juizo, ''),   contatos_processo.juizo),
      posicao = COALESCE(NULLIF(excluded.posicao, ''), contatos_processo.posicao),
      processo = excluded.processo, card_id = excluded.card_id,
      updated_at = unixepoch()
  `).run(chave, dados.processo || '', dados.cardId || '', dados.nome || '', phone,
         dados.partes || '', dados.juizo || '', dados.posicao || '');
}

export function buscarContatoProcesso(processo: string, cardId: string): ContatoProcesso | null {
  const r = getDb().prepare('SELECT nome, phone, partes, juizo, posicao FROM contatos_processo WHERE chave = ?')
    .get(chaveContato(processo, cardId)) as any;
  if (!r) return null;
  const algo = r.nome || r.phone || r.partes || r.juizo || r.posicao;
  return algo ? { nome: r.nome || '', phone: r.phone || '', partes: r.partes || '', juizo: r.juizo || '', posicao: r.posicao || '' } : null;
}

export function listarContatosProcesso(): any[] {
  return getDb().prepare('SELECT * FROM contatos_processo ORDER BY updated_at DESC').all() as any[];
}

// ─── Janela de agrupamento, em banco para sobreviver a reinícios ──────────────

// Guarda a mensagem e reinicia a contagem: enquanto o cliente fala, não responde
export function acumularNaJanela(phone: string, texto: string, waName?: string) {
  const t = String(texto || '').trim();
  getDb().prepare(`
    INSERT INTO janelas_resposta (phone, textos, wa_name, ultima_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(phone) DO UPDATE SET
      textos = CASE WHEN ? = '' THEN janelas_resposta.textos
                    ELSE TRIM(COALESCE(janelas_resposta.textos, '') || char(10) || ?) END,
      wa_name = COALESCE(NULLIF(excluded.wa_name, ''), janelas_resposta.wa_name),
      ultima_at = unixepoch()
  `).run(phone, t, waName || '', t, t);
}

// Janelas em que o cliente já parou de falar há tempo suficiente
export function janelasVencidas(minutos: number): Array<{ phone: string; textos: string; wa_name: string }> {
  const limite = Math.floor(Date.now() / 1000) - minutos * 60;
  return getDb().prepare('SELECT phone, textos, wa_name FROM janelas_resposta WHERE ultima_at <= ?')
    .all(limite) as any[];
}

export function removerJanela(phone: string) {
  getDb().prepare('DELETE FROM janelas_resposta WHERE phone = ?').run(phone);
}

// Primeira vez que este card aparece na lista? É o gatilho do aviso de audiência
// nova. Retorna true só na primeira chamada.
export function registrarCardVisto(cardId: string, tipo: string): boolean {
  const r = getDb().prepare('INSERT OR IGNORE INTO cards_vistos (card_id, tipo) VALUES (?, ?)').run(cardId, tipo);
  return r.changes > 0;
}

// Acrescenta uma coluna a uma tabela já existente, se ela ainda não estiver lá
function garantirColuna(tabela: string, coluna: string, definicao: string) {
  try {
    const cols = getDb().prepare(`PRAGMA table_info(${tabela})`).all() as any[];
    if (!cols.length) return; // tabela ainda não existe; o CREATE já a cria completa
    if (cols.some(c => c.name === coluna)) return;
    getDb().prepare(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`).run();
    console.log(`[db] coluna ${tabela}.${coluna} adicionada`);
  } catch (err) {
    console.error(`[db] falha ao garantir coluna ${tabela}.${coluna}:`, err);
  }
}

export function salvarAvisoPendente(a: {
  tipo: string; cardId: string; cardNome: string; processo: string;
  phone: string; nome: string; datasJson: string; mensagem: string; cadastrado: boolean;
  partes?: string; juizo?: string; posicao?: string; momento?: string;
}): boolean {
  // UNIQUE(card_id, tipo) impede duplicar o que já está na fila. Mas o descarte
  // apenas marca a linha, e com INSERT OR IGNORE o card descartado nunca voltava
  // — depois de "descartar todos" para regerar, só 8 de 29 reapareciam. Agora um
  // card DESCARTADO é reaproveitado com o texto novo; um já ENVIADO continua de
  // fora, para o cliente não receber o mesmo aviso duas vezes.
  const r = getDb().prepare(`
    INSERT INTO avisos_pendentes
      (tipo, card_id, card_nome, processo, phone, nome, datas_json, mensagem, cadastrado, partes, juizo, posicao, momento)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id, tipo, momento) DO UPDATE SET
      card_nome = excluded.card_nome, processo = excluded.processo,
      phone = excluded.phone, nome = excluded.nome,
      datas_json = excluded.datas_json, mensagem = excluded.mensagem,
      cadastrado = excluded.cadastrado, partes = excluded.partes, juizo = excluded.juizo,
      posicao = excluded.posicao,
      status = 'pendente', data_escolhida = NULL, created_at = unixepoch()
    WHERE avisos_pendentes.status = 'descartado'
  `).run(a.tipo, a.cardId, a.cardNome, a.processo, a.phone, a.nome, a.datasJson, a.mensagem,
         a.cadastrado ? 1 : 0, a.partes || '', a.juizo || '', a.posicao || '', a.momento || 'dia');
  return r.changes > 0;
}

// Wesley corrige nome e telefone direto na tela — principalmente nos processos
// que ainda não estão na planilha, onde o nome é só um palpite tirado do card
export function atualizarContatoAviso(id: number, nome: string, phone: string, mensagem?: string) {
  const campos = mensagem !== undefined
    ? 'nome = ?, phone = ?, mensagem = ?'
    : 'nome = ?, phone = ?';
  const args: any[] = mensagem !== undefined ? [nome, phone, mensagem, id] : [nome, phone, id];
  getDb().prepare(`UPDATE avisos_pendentes SET ${campos} WHERE id = ?`).run(...args);
}

// Guarda no próprio aviso as correções de partes, juízo e posição, para a tela
// continuar mostrando o corrigido enquanto ele estiver na fila
export function atualizarDadosAviso(id: number, d: { partes?: string; juizo?: string; posicao?: string }) {
  getDb().prepare(`
    UPDATE avisos_pendentes SET
      partes  = COALESCE(NULLIF(?, ''), partes),
      juizo   = COALESCE(NULLIF(?, ''), juizo),
      posicao = COALESCE(NULLIF(?, ''), posicao)
    WHERE id = ?
  `).run(d.partes || '', d.juizo || '', d.posicao || '', id);
}

export function listarAvisosPendentes(): any[] {
  return getDb().prepare(
    `SELECT * FROM avisos_pendentes WHERE status = 'pendente' ORDER BY created_at DESC, id DESC`
  ).all() as any[];
}

export function getAvisoPendente(id: number): any {
  return getDb().prepare('SELECT * FROM avisos_pendentes WHERE id = ?').get(id) as any;
}

export function marcarAvisoEnviado(id: number, dataEscolhida: string, mensagem: string) {
  getDb().prepare(
    `UPDATE avisos_pendentes SET status = 'enviado', data_escolhida = ?, mensagem = ? WHERE id = ?`
  ).run(dataEscolhida, mensagem, id);
}

// Descarta a fila inteira de avisos, para regerar com o texto novo depois de
// uma mudança de modelo de mensagem. Devolve quantos foram descartados.
export function descartarTodosAvisos(): number {
  return getDb().prepare(`UPDATE avisos_pendentes SET status = 'descartado' WHERE status = 'pendente'`).run().changes;
}

export function marcarAvisoDescartado(id: number) {
  getDb().prepare(`UPDATE avisos_pendentes SET status = 'descartado' WHERE id = ?`).run(id);
}

// Marca um evento do WhatsApp como processado. Retorna true apenas na PRIMEIRA
// vez — as entregas repetidas do mesmo evento devolvem false e são descartadas.
// A checagem e a gravação são uma instrução só, então entregas simultâneas não
// conseguem passar as duas.
export function registrarEventoNovo(eventId: string): boolean {
  const r = getDb().prepare('INSERT OR IGNORE INTO eventos_processados (event_id) VALUES (?)').run(eventId);
  return r.changes > 0;
}

// Mantém a tabela pequena: identificadores com mais de 2 dias não servem mais,
// já que as entregas repetidas chegam em milissegundos
export function limparEventosAntigos() {
  const limite = Math.floor(Date.now() / 1000) - 2 * 86400;
  getDb().prepare('DELETE FROM eventos_processados WHERE created_at < ?').run(limite);
}

// Wesley respondeu alguém há pouco? Se ele está atendendo agora, dizer ao cliente
// que ele só retorna em horário comercial contradiz o que o cliente está vendo.
// Sem telefone: qualquer contato (ele assumiu o atendimento). Com telefone:
// apenas aquela conversa. Só conta fala digitada por ele — o eco das mensagens
// da própria Iara é descartado na entrada do webhook.
export function houveRespostaDeWesley(minutos: number, phone?: string): boolean {
  const limite = Math.floor(Date.now() / 1000) - minutos * 60;
  const row = phone
    ? getDb().prepare(`SELECT 1 FROM messages WHERE role = 'wesley' AND created_at > ? AND phone = ? LIMIT 1`).get(limite, phone)
    : getDb().prepare(`SELECT 1 FROM messages WHERE role = 'wesley' AND created_at > ? LIMIT 1`).get(limite);
  return !!row;
}

// Reivindica o aviso de ausência do dia de forma ATÔMICA: retorna true só para a
// primeira chamada do dia para esse telefone. Duas mensagens do mesmo contato
// chegando juntas (ex.: duas fotos no mesmo segundo) passavam as duas pela
// verificação getAusenciaNotice() antes de qualquer uma gravar — o cliente recebia
// o aviso duplicado. Aqui a checagem e a gravação acontecem numa única instrução.
export function reivindicarAusencia(phone: string, dataHoje: string): boolean {
  const r = getDb().prepare(`
    INSERT INTO ausencia_notices (phone, sent_date, pending) VALUES (?, ?, 0)
    ON CONFLICT(phone) DO UPDATE SET sent_date = excluded.sent_date, pending = 0
      WHERE ausencia_notices.sent_date IS NOT excluded.sent_date
  `).run(phone, dataHoje);
  return r.changes > 0;
}

// Devolve a reivindicação quando o envio falha, para que uma próxima mensagem
// do contato possa tentar de novo em vez de ficar o dia todo sem aviso
export function liberarAusencia(phone: string) {
  getDb().prepare('UPDATE ausencia_notices SET sent_date = NULL WHERE phone = ?').run(phone);
}

export function marcarAusenciaEnviada(phone: string, dataHoje: string) {
  getDb().prepare(`
    INSERT INTO ausencia_notices (phone, sent_date, pending) VALUES (?, ?, 0)
    ON CONFLICT(phone) DO UPDATE SET sent_date = excluded.sent_date, pending = 0
  `).run(phone, dataHoje);
}

export function marcarAusenciaPendente(phone: string) {
  getDb().prepare(`
    INSERT INTO ausencia_notices (phone, sent_date, pending) VALUES (?, NULL, 1)
    ON CONFLICT(phone) DO UPDATE SET pending = 1
  `).run(phone);
}

export function getAusenciasPendentes(): string[] {
  return (getDb().prepare('SELECT phone FROM ausencia_notices WHERE pending = 1').all() as any[])
    .map(r => r.phone);
}

// ─── Grupos do WhatsApp: quais têm atendimento por IA ativado ───────────────────

export function upsertGroupSeen(groupId: string, groupName: string) {
  getDb().prepare(`
    INSERT INTO group_permissions (group_id, group_name, active) VALUES (?, ?, 0)
    ON CONFLICT(group_id) DO UPDATE SET group_name = excluded.group_name
  `).run(groupId, groupName || groupId);
}

export function getGroups(): Array<{ group_id: string; group_name: string; active: number; created_at: number }> {
  return getDb().prepare('SELECT * FROM group_permissions ORDER BY created_at DESC').all() as any[];
}

export function isGroupActive(groupId: string): boolean {
  const row = getDb().prepare('SELECT active FROM group_permissions WHERE group_id = ?').get(groupId) as any;
  return !!row?.active;
}

export function setGroupActive(groupId: string, active: boolean) {
  getDb().prepare('UPDATE group_permissions SET active = ? WHERE group_id = ?').run(active ? 1 : 0, groupId);
}

export function isBlacklisted(phone: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM blacklist WHERE phone = ?').get(phone);
}

export function addBlacklist(phone: string, reason: string) {
  getDb().prepare('INSERT OR REPLACE INTO blacklist (phone, reason) VALUES (?, ?)').run(phone, reason);
}

export function getContactInstruction(phone: string): string | null {
  const row = getDb().prepare('SELECT instruction FROM contact_instructions WHERE phone = ?').get(phone) as any;
  return row?.instruction || null;
}

export function setContactInstruction(phone: string, instruction: string) {
  getDb().prepare('INSERT OR REPLACE INTO contact_instructions (phone, instruction, updated_at) VALUES (?, ?, unixepoch())')
    .run(phone, instruction);
}

export function scheduleFollowUp(phone: string, message: string, scheduledAt: Date) {
  getDb().prepare('INSERT INTO follow_ups (phone, message, scheduled_at) VALUES (?, ?, ?)')
    .run(phone, message, Math.floor(scheduledAt.getTime() / 1000));
}

export function getDueFollowUps() {
  const now = Math.floor(Date.now() / 1000);
  return getDb().prepare('SELECT * FROM follow_ups WHERE scheduled_at <= ? AND sent = 0').all(now) as any[];
}

export function markFollowUpSent(id: number) {
  getDb().prepare('UPDATE follow_ups SET sent = 1 WHERE id = ?').run(id);
}

// ─── Follow-ups v2 (com recorrência e condições de parada) ───────────────────

export interface FollowUpV2 {
  id: number;
  phone: string;
  message: string;
  next_send_at: number;
  recurrence_days: number;
  stop_condition: 'date' | 'reply' | 'document' | 'manual';
  stop_date: number | null;
  status: 'ativo' | 'pausado' | 'concluido';
  created_at: number;
}

export function createFollowUpV2(params: {
  phone: string;
  message: string;
  nextSendAt: Date;
  recurrenceDays: number;
  stopCondition: FollowUpV2['stop_condition'];
  stopDate?: Date;
}): number {
  const r = getDb().prepare(`
    INSERT INTO follow_ups_v2 (phone, message, next_send_at, recurrence_days, stop_condition, stop_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.phone,
    params.message,
    Math.floor(params.nextSendAt.getTime() / 1000),
    params.recurrenceDays,
    params.stopCondition,
    params.stopDate ? Math.floor(params.stopDate.getTime() / 1000) : null
  );
  return r.lastInsertRowid as number;
}

export function getDueFollowUpsV2(): FollowUpV2[] {
  const now = Math.floor(Date.now() / 1000);
  return getDb().prepare(`
    SELECT * FROM follow_ups_v2
    WHERE status = 'ativo' AND next_send_at <= ?
  `).all(now) as FollowUpV2[];
}

export function getFollowUpsForPhone(phone: string): FollowUpV2[] {
  return getDb().prepare('SELECT * FROM follow_ups_v2 WHERE phone = ? ORDER BY created_at DESC').all(phone) as FollowUpV2[];
}

export function rescheduleFollowUpV2(id: number, nextSendAt: Date) {
  getDb().prepare('UPDATE follow_ups_v2 SET next_send_at = ? WHERE id = ?')
    .run(Math.floor(nextSendAt.getTime() / 1000), id);
}

export function updateFollowUpV2Status(id: number, status: FollowUpV2['status']) {
  getDb().prepare('UPDATE follow_ups_v2 SET status = ? WHERE id = ?').run(status, id);
}

export function cancelFollowUpsOnReply(phone: string) {
  getDb().prepare(`UPDATE follow_ups_v2 SET status = 'concluido' WHERE phone = ? AND status = 'ativo' AND stop_condition = 'reply'`)
    .run(phone);
}

export function purgeOldMessages(days = 90) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  getDb().prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
}

// ─── Settings (modo ausência, etc.) ──────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
  return row?.value || null;
}

export function setSetting(key: string, value: string | null) {
  if (value === null) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())')
      .run(key, value);
  }
}
