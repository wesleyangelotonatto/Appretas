import { google } from 'googleapis';

const SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '';

function getAuth() {
  return new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    undefined,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
}

export interface ContactInfo {
  name: string;
  phone: string;
  processes: string[];
  rawRow: any[];
}

export async function lookupSheets(phone: string): Promise<ContactInfo | null> {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range: 'A:Z',
    });

    const rows = res.data.values || [];
    if (rows.length < 2) return null;

    const headers = rows[0].map((h: string) => h?.toLowerCase().trim());
    const phoneColIndex = headers.findIndex((h: string) =>
      h.includes('telefone') || h.includes('fone') || h.includes('celular') || h.includes('whatsapp')
    );
    const nameColIndex = headers.findIndex((h: string) =>
      h.includes('nome') || h.includes('cliente')
    );
    const processColIndex = headers.findIndex((h: string) =>
      h.includes('processo') || h.includes('número') || h.includes('numero')
    );

    if (phoneColIndex === -1) return null;

    // Normaliza o número de busca para comparação
    const normalizedSearch = phone.replace(/[^0-9]/g, '');

    for (const row of rows.slice(1)) {
      const cellPhone = String(row[phoneColIndex] || '').replace(/[^0-9]/g, '');
      if (!cellPhone) continue;

      // Compara sufixo de 10 dígitos (DDD + número) para tolerar formatação diferente
      // (com/sem 55, com/sem o 9 extra) sem colidir entre DDDs diferentes — 8 dígitos
      // (sem DDD) já causou casos reais de atribuir cliente errado por coincidência
      if (
        cellPhone === normalizedSearch ||
        cellPhone.endsWith(normalizedSearch.slice(-10)) ||
        normalizedSearch.endsWith(cellPhone.slice(-10))
      ) {
        const name = nameColIndex >= 0 ? String(row[nameColIndex] || '') : 'Desconhecido';
        const processRaw = processColIndex >= 0 ? String(row[processColIndex] || '') : '';
        const processes = processRaw ? processRaw.split(/[,;\n]+/).map(p => p.trim()).filter(Boolean) : [];

        return { name, phone: cellPhone, processes, rawRow: row };
      }
    }

    return null;
  } catch (err) {
    console.error('[sheets] erro no lookup:', err);
    return null;
  }
}
