import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import path from 'path';
import cron from 'node-cron';
import { initDb } from './memory/db';
import { webhookRouter } from './webhook/waspeed';
import { commandRouter } from './commands/router';
import { cronAudiencias } from './cron/audiencias';
import { cronPrazos } from './cron/prazos';

const PORT = process.env.PORT || 3000;

export const app = express();
export const server = http.createServer(app);
export const io = new SocketIO(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Disponibiliza io para os módulos via app.locals
app.locals.io = io;

// Rotas
app.use('/webhook', webhookRouter);
app.use('/command', commandRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Socket.IO: conexão do painel
io.on('connection', (socket) => {
  console.log('[painel] conectado:', socket.id);
  socket.on('disconnect', () => console.log('[painel] desconectado:', socket.id));
});

// Cron jobs (Brasília timezone via TZ_APP)
const TZ = process.env.TZ_APP || 'America/Sao_Paulo';
// Audiências: dias úteis 08h + sextas 09h (coberto internamente)
cron.schedule('0 8 * * 1-5', () => cronAudiencias(), { timezone: TZ });
// Prazos: dias úteis 08h
cron.schedule('0 8 * * 1-5', () => cronPrazos(), { timezone: TZ });

async function main() {
  await initDb();
  server.listen(PORT, () => {
    console.log(`[iara] servidor rodando em http://localhost:${PORT}`);
    console.log(`[iara] modo treino: ${process.env.MODO_TREINO === 'true' ? 'ATIVO' : 'DESATIVADO'}`);
  });
}

main().catch(console.error);
