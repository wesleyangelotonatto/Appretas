import { google } from 'googleapis';
import { Readable } from 'stream';

const ROOT_FOLDER_ID = () => process.env.DRIVE_FOLDER_ID || '';

// Mesmo endereço de retorno já cadastrado no cliente OAuth do escritório (usado pelo CRM):
// evita ter de mexer no Google Cloud para reconectar.
const REDIRECT_URI = 'https://developers.google.com/oauthplayground';

// O refresh token salvo pela reconexão (no banco) tem prioridade sobre a variável de ambiente,
// que pode estar vencida. Sobrevive a reinícios.
function refreshTokenAtual(): string | undefined {
  try {
    const { getSetting } = require('../memory/db');
    return getSetting('google_refresh_token') || process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  } catch { return process.env.GOOGLE_OAUTH_REFRESH_TOKEN; }
}

function novoCliente() {
  return new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET, REDIRECT_URI);
}

function getAuth() {
  const oauth2 = novoCliente();
  oauth2.setCredentials({ refresh_token: refreshTokenAtual() });
  oauth2.on('tokens', (t) => {
    if (t.refresh_token) {
      try { require('../memory/db').setSetting('google_refresh_token', t.refresh_token); } catch { /* ignora */ }
    }
  });
  return oauth2;
}

// ── Reconexão do Google Drive pelo painel ──────────────────────────────────
export function urlAutorizacao(): string {
  return novoCliente().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive'],
  });
}

// Recebe o código (ou o endereço inteiro copiado da barra do navegador),
// troca por um refresh token, salva no banco e confere acessando a pasta raiz.
export async function concluirAutorizacao(codigoOuUrl: string): Promise<{ ok: boolean; erro?: string; refreshToken?: string }> {
  try {
    let code = codigoOuUrl.trim();
    const m = code.match(/[?&]code=([^&\s]+)/);
    if (m) code = decodeURIComponent(m[1]);
    const { tokens } = await novoCliente().getToken(code);
    if (!tokens.refresh_token) return { ok: false, erro: 'O Google não devolveu autorização permanente. Tente de novo pelo link.' };
    require('../memory/db').setSetting('google_refresh_token', tokens.refresh_token);
    const teste = await testarDrive();
    if (!teste.ok) return { ok: false, erro: `Autorizado, mas sem acesso à pasta: ${teste.erro}` };
    return { ok: true, refreshToken: tokens.refresh_token };
  } catch (err: any) {
    return { ok: false, erro: String(err?.response?.data?.error_description || err?.message || err) };
  }
}

export async function testarDrive(): Promise<{ ok: boolean; erro?: string }> {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !refreshTokenAtual()) return { ok: false, erro: 'credenciais do Google ausentes' };
  try {
    await getDrive().files.get({ fileId: ROOT_FOLDER_ID() || 'root', fields: 'id' });
    return { ok: true };
  } catch (err: any) {
    const msg = String(err?.response?.data?.error || err?.message || err);
    return { ok: false, erro: msg.includes('invalid_grant') ? 'autorização do Google vencida — reconecte o Drive' : msg };
  }
}

function getDrive() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

// Escapa aspas simples e barras invertidas antes de interpolar em uma query do Drive
// (name vem de nome de contato do WhatsApp/Trello, não confiável — ex: "O'Brien" quebraria a query)
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findOrCreateFolder(name: string, parentId: string): Promise<string> {
  const drive = getDrive();
  const safeName = escapeDriveQueryValue(name);
  const safeParentId = escapeDriveQueryValue(parentId);

  const res = await drive.files.list({
    q: `name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and '${safeParentId}' in parents and trashed = false`,
    fields: 'files(id)',
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id!;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });

  return created.data.id!;
}

export async function saveConversationSummary(phone: string, name: string, summary: string, dataStr?: string): Promise<void> {
  try {
    const drive = getDrive();
    const contactFolder = await findOrCreateFolder(name || phone, ROOT_FOLDER_ID());
    // Data do dia resumido (AAAA-MM-DD → DD-MM-AAAA), sempre no fuso de São Paulo
    const today = dataStr
      ? dataStr.split('-').reverse().join('-')
      : new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(/\//g, '-');
    const fileName = `Resumo_${today}.txt`;

    const content = [
      `Contato: ${name || phone}`,
      `Telefone: ${phone}`,
      `Data: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
      '',
      'RESUMO DAS CONVERSAS:',
      summary,
    ].join('\n');

    const stream = new Readable();
    stream.push(content);
    stream.push(null);

    await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [contactFolder],
        mimeType: 'text/plain',
      },
      media: {
        mimeType: 'text/plain',
        body: stream,
      },
    });
  } catch (err) {
    console.error('[drive] erro ao salvar resumo:', err);
  }
}

export async function saveDocument(phone: string, name: string, fileName: string, content: Buffer, mimeType: string): Promise<string> {
  try {
    const drive = getDrive();
    const contactFolder = await findOrCreateFolder(name || phone, ROOT_FOLDER_ID());

    const stream = new Readable();
    stream.push(content);
    stream.push(null);

    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [contactFolder],
        mimeType,
      },
      media: {
        mimeType,
        body: stream,
      },
      fields: 'id,webViewLink',
    });

    return res.data.webViewLink || res.data.id || '';
  } catch (err) {
    console.error('[drive] erro ao salvar documento:', err);
    guardarPendente(phone, name, fileName, content, mimeType);
    return '';
  }
}

// Envia um arquivo de backup para a pasta "_Backups Iara" dentro da pasta raiz.
// Fica fora das pastas de clientes; mantém só os últimos N arquivos.
export async function enviarBackupDrive(nomeArquivo: string, caminhoLocal: string, manter = 30): Promise<void> {
  const fs = await import('fs');
  const drive = getDrive();
  const pasta = await findOrCreateFolder('_Backups Iara', ROOT_FOLDER_ID());
  await drive.files.create({
    requestBody: { name: nomeArquivo, parents: [pasta] },
    media: { mimeType: 'application/gzip', body: fs.createReadStream(caminhoLocal) },
    fields: 'id',
  });
  const lista = await drive.files.list({
    q: `'${escapeDriveQueryValue(pasta)}' in parents and trashed = false`,
    orderBy: 'createdTime desc', fields: 'files(id,name)', pageSize: 200,
  });
  const antigos = (lista.data.files || []).slice(manter);
  for (const f of antigos) {
    if (f.id) await drive.files.delete({ fileId: f.id }).catch(() => {});
  }
}

// ── Documentos que não subiram ao Drive ficam guardados no volume e sobem depois ──
function dirPendentes(): string {
  const path = require('path');
  const base = path.dirname(process.env.DATABASE_URL || './data/iara.db');
  return path.join(base, 'drive-pendente');
}

function guardarPendente(phone: string, name: string, fileName: string, content: Buffer, mimeType: string) {
  try {
    const fs = require('fs'); const path = require('path');
    const dir = dirPendentes(); fs.mkdirSync(dir, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(path.join(dir, `${id}.bin`), content);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ phone, name, fileName, mimeType }));
    console.log(`[drive] documento guardado para envio posterior: ${fileName} (${phone})`);
  } catch (e) { console.error('[drive] não consegui guardar o documento pendente:', e); }
}

export function contarPendentes(): number {
  try { return require('fs').readdirSync(dirPendentes()).filter((f: string) => f.endsWith('.json')).length; } catch { return 0; }
}

// Reenvia ao Drive os documentos guardados; para no primeiro erro (Drive ainda fora)
export async function reenviarPendentes(): Promise<{ enviados: number; restantes: number }> {
  const fs = require('fs'); const path = require('path');
  const dir = dirPendentes();
  let enviados = 0;
  if (!fs.existsSync(dir)) return { enviados, restantes: 0 };
  for (const f of fs.readdirSync(dir).filter((x: string) => x.endsWith('.json')).sort()) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const bin = path.join(dir, f.replace(/\.json$/, '.bin'));
    try {
      const drive = getDrive();
      const pasta = await findOrCreateFolder(meta.name || meta.phone, ROOT_FOLDER_ID());
      const stream = new Readable(); stream.push(fs.readFileSync(bin)); stream.push(null);
      await drive.files.create({ requestBody: { name: meta.fileName, parents: [pasta], mimeType: meta.mimeType }, media: { mimeType: meta.mimeType, body: stream }, fields: 'id' });
      fs.unlinkSync(bin); fs.unlinkSync(path.join(dir, f));
      enviados++;
    } catch (err) {
      console.error('[drive] reenvio de pendentes interrompido:', err);
      break;
    }
  }
  return { enviados, restantes: contarPendentes() };
}
