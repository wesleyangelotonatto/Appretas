// Janela de mensagens proativas para quem não é lead (decisão de 26/11):
// dias úteis, das 08h às 21h, horário de São Paulo. Leads são atendidos 24 horas.
const TZ = () => process.env.TZ_APP || 'America/Sao_Paulo';

export function dentroDaJanelaComercial(agora: Date = new Date()): boolean {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: TZ(), weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(agora);
  const dia = partes.find(p => p.type === 'weekday')?.value || '';
  const hora = parseInt(partes.find(p => p.type === 'hour')?.value || '0', 10) % 24;
  const diaUtil = !['Sat', 'Sun'].includes(dia);
  return diaUtil && hora >= 8 && hora < 21;
}
