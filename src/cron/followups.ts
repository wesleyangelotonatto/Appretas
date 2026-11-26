import { getDueFollowUps, markFollowUpSent, getDueFollowUpsV2, rescheduleFollowUpV2, updateFollowUpV2Status, saveMessage } from '../memory/db';
import { sendMessage } from '../responder/send';
import { dentroDaJanelaComercial } from '../flow/janela';

const saiu = (status: string) => status === 'enviado' || status === 'na_fila';

export async function cronFollowUps(): Promise<void> {
  // Follow-ups só saem em dias úteis, das 08h às 21h; fora disso ficam para a próxima janela
  if (!dentroDaJanelaComercial()) return;

  // ─── Follow-ups legados (simples) ──────────────────────────────────────────
  const legacyDue = getDueFollowUps();
  for (const fu of legacyDue) {
    try {
      const r = await sendMessage(fu.phone, fu.message);
      if (!saiu(r.status)) { console.log(`[cron-followup] legado não saiu (${r.status}) — ${fu.phone}`); continue; }
      markFollowUpSent(fu.id);
      console.log(`[cron-followup] legado enviado para ${fu.phone}`);
    } catch (err) {
      // Erro definitivo (número inválido etc.): encerra para não tentar a cada hora para sempre
      markFollowUpSent(fu.id);
      console.error(`[cron-followup] erro definitivo legado ${fu.phone} — encerrado:`, err);
    }
  }

  // ─── Follow-ups v2 (com recorrência e condições de parada) ────────────────
  const due = getDueFollowUpsV2();
  for (const fu of due) {
    const now = Date.now();

    // Verifica condição de parada por data
    if (fu.stop_condition === 'date' && fu.stop_date && Math.floor(now / 1000) > fu.stop_date) {
      updateFollowUpV2Status(fu.id, 'concluido');
      console.log(`[cron-followup] encerrado por data — ${fu.phone}`);
      continue;
    }

    try {
      const r = await sendMessage(fu.phone, fu.message);
      if (!saiu(r.status)) { console.log(`[cron-followup] v2 não saiu (${r.status}) — ${fu.phone}`); continue; }
      saveMessage(fu.phone, 'iara', fu.message);
      console.log(`[cron-followup] v2 enviado para ${fu.phone}`);

      if (fu.recurrence_days > 0) {
        // Reagenda para o próximo envio
        const next = new Date(now + fu.recurrence_days * 86400 * 1000);

        // Se há data de parada e o próximo envio é depois dela, encerra
        if (fu.stop_condition === 'date' && fu.stop_date && Math.floor(next.getTime() / 1000) > fu.stop_date) {
          updateFollowUpV2Status(fu.id, 'concluido');
          console.log(`[cron-followup] último envio (próximo ultrapassaria data limite) — ${fu.phone}`);
        } else {
          rescheduleFollowUpV2(fu.id, next);
        }
      } else {
        updateFollowUpV2Status(fu.id, 'concluido');
      }
    } catch (err) {
      // Erro definitivo: pausa (aparece no painel) em vez de repetir a cada hora
      updateFollowUpV2Status(fu.id, 'pausado');
      console.error(`[cron-followup] erro definitivo v2 ${fu.phone} — pausado:`, err);
    }
  }
}
