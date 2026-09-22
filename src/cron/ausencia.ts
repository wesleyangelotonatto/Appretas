import { getAusenciasPendentes, marcarAusenciaEnviada, saveMessage, houveRespostaDeWesley } from '../memory/db';
import { sendMessage } from '../responder/send';
import { MSG_FORA_HORARIO } from '../persona';
import { io } from '../server';

// Roda às 07h: entrega o aviso de ausência aos contatos que mandaram mensagem
// fora da janela 07h-22h e ainda não foram avisados
export async function cronAusenciaPendentes(): Promise<void> {
  const pendentes = getAusenciasPendentes();
  if (!pendentes.length) {
    console.log('[cron-ausencia] nenhum aviso pendente');
    return;
  }

  const hojeStr = new Date().toLocaleDateString('sv-SE', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' });
  let enviados = 0;

  const minutosAtividade = parseInt(process.env.MINUTOS_ATIVIDADE_WESLEY || '') || 90;

  for (const phone of pendentes) {
    try {
      // Mesma trava do fluxo ao vivo: se Wesley já assumiu a conversa, o aviso
      // represado perdeu o sentido e fica só para o dia em que ele não atender
      if (houveRespostaDeWesley(minutosAtividade, phone)) {
        console.log(`[cron-ausencia] suprimido — Wesley já respondeu ${phone}`);
        continue;
      }
      await sendMessage(phone, MSG_FORA_HORARIO);
      saveMessage(phone, 'iara', MSG_FORA_HORARIO);
      io?.emit('message', { phone, role: 'iara', body: MSG_FORA_HORARIO, timestamp: Date.now() });
      marcarAusenciaEnviada(phone, hojeStr);
      enviados++;
    } catch (err) {
      console.error(`[cron-ausencia] erro ao enviar para ${phone}:`, err);
    }
  }

  console.log(`[cron-ausencia] ${enviados} aviso(s) pendente(s) entregue(s)`);
}
