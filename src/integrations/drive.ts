import { google } from 'googleapis';
import { Readable } from 'stream';

const ROOT_FOLDER_ID = () => process.env.DRIVE_FOLDER_ID || '';

function getAuth() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  return oauth2;
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
