import { getDueFollowUps, markFollowUpSent } from '../memory/db';
import { sendMessage } from '../responder/send';

// Executado pelo server.ts a cada hora
export async function cronFollowUps(): Promise<void> {
  const due = getDueFollowUps();
  for (const followUp of due) {
    try {
      await sendMessage(followUp.phone, followUp.message);
      markFollowUpSent(followUp.id);
      console.log(`[cron-followup] enviado para ${followUp.phone}`);
    } catch (err) {
      console.error(`[cron-followup] erro ao enviar para ${followUp.phone}:`, err);
    }
  }
}
