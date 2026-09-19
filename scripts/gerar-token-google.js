/**
 * Roda uma vez para gerar o GOOGLE_OAUTH_REFRESH_TOKEN.
 * Uso: node scripts/gerar-token-google.js
 *
 * Pré-requisito: npm install googleapis (já está no package.json)
 */

const { google } = require('googleapis');
const http = require('http');
const url = require('url');

// ── Preencha com seus dados do Google Cloud Console ───────────────────────────
const CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID     || 'COLE_AQUI';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || 'COLE_AQUI';
const REDIRECT_URI  = 'http://localhost:3333/callback';
// ─────────────────────────────────────────────────────────────────────────────

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',           // força emitir refresh_token mesmo se já autorizou antes
  scope: [
    'https://www.googleapis.com/auth/drive',
  ],
});

console.log('\n=== PASSO 1 ===');
console.log('Abra este link no navegador e faça login com a conta do Google que tem acesso ao Drive:\n');
console.log(authUrl);
console.log('\nAguardando autorização...\n');

// Servidor temporário para capturar o callback
const server = http.createServer(async (req, res) => {
  const { code } = url.parse(req.url, true).query;
  if (!code) {
    res.end('Parâmetro "code" não encontrado. Tente novamente.');
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    res.end('<h2>Autorizado! Feche esta janela e veja o terminal.</h2>');
    server.close();

    console.log('\n=== PASSO 2 — Copie este valor para o Railway ===');
    console.log('\nGOOGLE_OAUTH_REFRESH_TOKEN =', tokens.refresh_token);
    console.log('\n(O access_token e expiry_date são temporários — apenas o refresh_token importa)');
  } catch (err) {
    res.end('Erro ao trocar o código: ' + err.message);
    console.error('Erro:', err);
  }
});

server.listen(3333, () => {
  console.log('Servidor de callback rodando em http://localhost:3333');
});
