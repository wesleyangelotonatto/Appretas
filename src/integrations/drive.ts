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

async function findOrCreateFolder(name: string, parentId: string): Promise<string> {
  const drive = getDrive();

  const res = await drive.files.list({
    q: `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
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

export async function saveConversationSummary(phone: string, name: string, summary: string): Promise<void> {
  try {
    const drive = getDrive();
    const contactFolder = await findOrCreateFolder(name || phone, ROOT_FOLDER_ID());
    const today = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
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
