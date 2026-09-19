import { getDueFollowUps, markFollowUpSent, getDueFollowUpsV2, rescheduleFollowUpV2, updateFollowUpV2Status, saveMessage } from '../memory/db';
import { sendMessage } from '../responder/send';

export async function cronFollowUps(): Promise<void> {
  // ─── Follow-ups legados (simples) ──────────────────────────────────────────
  const legacyDue = getDueFollowUps();
  for (const fu of legacyDue) {
    try {
      await sendMessage(fu.phone, fu.message);
      markFollowUpSent(fu.id);
      console.log(`[cron-followup] legado enviado para ${fu.phone}`);
    } catch (err) {
      console.error(`[cron-followup] erro legado ${fu.phone}:`, err);
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
      await sendMessage(fu.phone, fu.message);
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
      console.error(`[cron-followup] erro v2 ${fu.phone}:`, err);
    }
  }
}
