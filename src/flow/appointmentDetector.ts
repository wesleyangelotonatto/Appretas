import Anthropic from '@anthropic-ai/sdk';
import { createCalendarEvent } from '../integrations/calendar';
import { saveMessage } from '../memory/db';
import { sendMessage } from '../responder/send';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WESLEY_NUMERO = process.env.WESLEY_NUMERO || '5544988596158';

// Dedup: evita processar o mesmo (telefone+corpo) duas vezes em 2 minutos
const recentDetections = new Map<string, number>();
function isDuplicate(phone: string, body: string): boolean {
  const key = `${phone}::${body.slice(0, 60)}`;
  const last = recentDetections.get(key);
  const now = Date.now();
  if (last && now - last < 2 * 60_000) return true;
  recentDetections.set(key, now);
  if (recentDetections.size > 200) {
    const oldest = [...recentDetections.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100);
    oldest.forEach(([k]) => recentDetections.delete(k));
  }
  return false;
}

export async function detectAppointment(
  phone: string,
  body: string,
  contactName: string | undefined,
  io: any
): Promise<void> {
  if (!body || body.length < 8) return;
  if (isDuplicate(phone, body)) return;

  const today = new Date().toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const prompt = `Você analisa mensagens de um advogado (Wesley) para detectar agendamentos confirmados.

Hoje é: ${today}
Contato da conversa: ${contactName || phone}
Mensagem: "${body}"

Detecte se a mensagem CONFIRMA ou MARCA um atendimento, reunião, consulta ou encontro com data E hora definidas.

Positivo: "te espero quinta às 14h", "reunião amanhã às 9", "pode vir segunda às 15h", "confirmado para 25/09 às 11h"
Negativo: "precisamos marcar", "quando você pode?", "vou ver minha agenda", "talvez na semana que vem"

Responda APENAS com JSON válido:
{"detected": true/false, "contactName": "nome ou null", "dateIso": "ISO 8601 em -03:00 ou null", "confidence": 0.0-1.0}`;

  let info: any;
  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = message.content[0].type === 'text' ? message.content[0].text : '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    info = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (err) {
    console.error('[agenda] erro na detecção:', err);
    return;
  }

  if (!info.detected || info.confidence < 0.80 || !info.dateIso) return;

  const name = info.contactName || contactName || phone;

  const dateLabel = new Date(info.dateIso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // 1. Salva no Google Calendar
  try {
    await createCalendarEvent({
      title: `Atendimento — ${name}`,
      startIso: info.dateIso,
      description: `Agendado automaticamente pela Iara.\nContato: ${phone}\nMensagem: "${body}"`,
    });
  } catch (err) {
    console.error('[agenda] erro ao salvar no Calendar:', err);
  }

  // 2. Salva no histórico SQLite do contato
  const nota = `[Agendamento detectado] Atendimento com ${name} para ${dateLabel}`;
  saveMessage(phone, 'iara_sistema', nota);

  // 3. Emite evento para o painel
  io?.emit('appointment', { phone, name, dateIso: info.dateIso, dateLabel, timestamp: Date.now() });
  console.log(`[agenda] atendimento registrado — ${name} — ${dateLabel}`);

  // 4. Notifica Wesley
  try {
    await sendMessage(WESLEY_NUMERO, `Agendar Atendimento com ${name} para ${dateLabel} ✓`);
  } catch (err) {
    console.error('[agenda] erro ao notificar Wesley:', err);
  }
}
