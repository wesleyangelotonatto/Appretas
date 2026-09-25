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
import { cronResumosDiarios, cronRelatorioWesley } from './cron/resumos';
import { getResumosDoDia, getDatasComResumo } from './memory/db';
import { cronAusenciaPendentes } from './cron/ausencia';

const PORT = process.env.PORT || 3000;

export const app = express();
export const server = http.createServer(app);
export const io = new SocketIO(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json({ limit: '200mb' }));
// O painel é um arquivo só, e o navegador o guardava em cache: toda mudança de
// tela exigia Ctrl+F5 para aparecer, o que já causou confusão (botão novo
// publicado e invisível na tela). Agora o HTML é sempre revalidado.
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res, caminho) => {
    if (caminho.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

// Disponibiliza io para os módulos via app.locals
app.locals.io = io;

// Payload muito grande: loga e descarta sem derrubar o processo
app.use((err: any, _req: any, res: any, next: any) => {
  if (err.type === 'entity.too.large') {
    console.warn('[webhook] payload rejeitado — arquivo muito grande (>200MB):', err.length || '?', 'bytes');
    res.status(413).json({ status: 'ignored', reason: 'payload too large' });
    return;
  }
  next(err);
});

// Rotas
app.use('/webhook', webhookRouter);
app.use('/command', commandRouter);

// Relatórios diários — consulta pelo painel
app.get('/api/resumos/datas', (_req, res) => {
  try {
    res.json(getDatasComResumo());
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar datas' });
  }
});

app.get('/api/resumos/:data', (req, res) => {
  try {
    const data = req.params.data; // formato YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      res.status(400).json({ error: 'Formato inválido. Use YYYY-MM-DD' });
      return;
    }
    res.json(getResumosDoDia(data));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar resumos' });
  }
});

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
// Avisos de "não esquecemos": DESLIGADO. Disparou três vezes para clientes que não
// aguardavam resposta. Decidir automaticamente quem está esperando retorno se mostrou
// pouco confiável para uma mensagem que vai direto ao cliente sem revisão. Continua
// disponível sob demanda pelo painel (POST /command/naorespondidos); para voltar a
// rodar sozinho, defina AVISOS_NAO_RESPONDIDOS=true.
if (process.env.AVISOS_NAO_RESPONDIDOS === 'true') {
  cron.schedule('0 * * * *', () => cronNaoRespondidos(), { timezone: TZ });
  console.log('[iara] avisos de não-respondidos: ATIVADOS (envio automático a cada hora)');
} else {
  console.log('[iara] avisos de não-respondidos: DESLIGADOS (nenhum envio automático)');
}
cron.schedule('0 22 * * *', () => cronResumosDiarios(), { timezone: TZ }); // todo dia às 22h — resumos + Drive + nota Waspeed
cron.schedule('0 21 * * *', () => cronRelatorioWesley(), { timezone: TZ }); // todo dia às 21h — relatório consolidado para Wesley
cron.schedule('0 7 * * *', () => cronAusenciaPendentes(), { timezone: TZ }); // todo dia às 07h — entrega avisos de ausência pendentes
// A cada minuto: responde as conversas cuja janela de agrupamento venceu. É o
// que torna a janela resistente a reinício — ao subir, a primeira passagem
// recolhe o que venceu enquanto o processo estava fora do ar.
setInterval(() => {
  import('./flow/orchestrator')
    .then(m => m.processarJanelasVencidas())
    .catch(err => console.error('[janelas] erro na verificação periódica:', err));
}, 60 * 1000);

cron.schedule('30 3 * * *', async () => {                                    // todo dia às 03h30 — limpa IDs de eventos antigos
  const { limparEventosAntigos } = await import('./memory/db');
  limparEventosAntigos();
}, { timezone: TZ });

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
