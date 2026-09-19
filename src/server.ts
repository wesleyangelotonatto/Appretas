import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import path from 'path';
import cron from 'node-cron';
import { initDb } from './memory/db';
import { initDjenCache } from './integrations/djen';
import { webhookRouter } from './webhook/waspeed';
import { commandRouter } from './commands/router';
import { cronAudiencias } from './cron/audiencias';
import { cronPrazos } from './cron/prazos';
import { cronFollowUps } from './cron/followups';
import { cronNaoRespondidos } from './cron/naorespondidos';
import { cronResumosDiarios } from './cron/resumos';

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

app.get('/health', (_req, res) => res.json({
  status: 'ok',
  modoTreino: process.env.MODO_TREINO === 'true',
  timestamp: new Date().toISOString()
}));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Socket.IO: conexão do painel
io.on('connection', (socket) => {
  console.log('[painel] conectado:', socket.id);
  // Envia estado inicial do modo treino
  socket.emit('config', { modoTreino: process.env.MODO_TREINO === 'true' });
  socket.on('disconnect', () => console.log('[painel] desconectado:', socket.id));
});

const TZ = process.env.TZ_APP || 'America/Sao_Paulo';

// Cron jobs
cron.schedule('0 8 * * 1-5', () => cronAudiencias(), { timezone: TZ });   // seg-sex 08h (audiências + prazos)
cron.schedule('0 8 * * 1-5', () => cronPrazos(), { timezone: TZ });        // seg-sex 08h
cron.schedule('0 * * * *', () => cronFollowUps(), { timezone: TZ });       // a cada hora
cron.schedule('0 * * * *', () => cronNaoRespondidos(), { timezone: TZ });  // a cada hora — avisos de não-esquecemos
cron.schedule('0 22 * * *', () => cronResumosDiarios(), { timezone: TZ }); // todo dia às 22h — resumos + Drive + nota Waspeed

async function main() {
  await initDb();
  initDjenCache();
  server.listen(PORT, () => {
    console.log(`[iara] servidor rodando em http://localhost:${PORT}`);
    console.log(`[iara] modo treino: ${process.env.MODO_TREINO === 'true' ? 'ATIVO (30 dias)' : 'DESATIVADO'}`);
    console.log(`[iara] webhook esperado em: POST /webhook`);
  });
}

main().catch(console.error);
