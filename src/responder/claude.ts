import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, aplicarGlossario, type Genero } from '../persona';
import { getRecentCorrections } from '../memory/db';
import type { ClassificationType } from '../classifier/groq';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TYPE_INSTRUCTIONS: Record<string, string> = {
  PROCESSO_ATIVO: `O cliente é um cliente ativo com um caso em andamento — pode ser um processo judicial ou um contrato/serviço não-judicial (elaboração, revisão, consultoria). Não assuma que é sempre um processo judicial. Informe sobre o andamento de forma simples e clara, usando os dados do DJEN e Trello fornecidos quando existirem (DJEN só se aplica a processo judicial). Se não houver dados, diga que vai verificar com o Dr. Wesley.`,
  NOVO_CASO_CLIENTE_ANTIGO: `O cliente é um cliente já atendido anteriormente, mas está trazendo um assunto novo. Recepcione-o, pergunte sobre o novo assunto e diga que vai repassar ao Dr. Wesley.`,
  LEAD_NOVO: `É um potencial novo cliente. Recepcione formalmente, pergunte o nome, o que precisa e peça para detalhar a situação. Se for caso jurídico, peça que envie documentos se tiver.`,
  NEGOCIO_PARTICULAR: `É um contato de negócio (não-advocatício). Recepcione educadamente, anote a pauta e diga que vai repassar ao Dr. Wesley.`,
  AMIGO_PESSOAL: `É uma mensagem de amigo/pessoal. Responda de forma leve e informal, dizendo que Wesley está em atendimento e vai retornar.`,
  INSTITUCIONAL: `É um contato institucional (OAB, Maçonaria, etc.). Resposta MUITO formal. Recepcione, anote a pauta e diga que Dr. Wesley retornará em breve.`,
  DESCONHECIDO: `A mensagem não traz dado novo classificável (pode ser cobrança de prazo, reclamação sobre demora, agradecimento, pergunta sobre quando o Dr. Wesley vai responder, etc.). Responda de forma direta e acolhedora ao que o cliente disse, sem repetir perguntas já feitas no histórico. Se ele estiver perguntando quanto tempo vai demorar, diga que não pode prometer prazo exato, mas que o Dr. Wesley foi avisado e responderá assim que possível.`,
};

export async function draftResponse(
  type: ClassificationType | string,
  clientMessage: string,
  context: string,
  genero: Genero = 'N',
  historico: Array<{ role: string; body: string }> = []
): Promise<string> {
  const typeInstruction = TYPE_INSTRUCTIONS[type] || TYPE_INSTRUCTIONS['DESCONHECIDO'];

  const historicoFormatado = historico.length > 0
    ? historico.map(m => `${m.role === 'client' ? 'Cliente' : m.role === 'iara' ? 'Iara' : 'Dr. Wesley'}: ${m.body}`).join('\n')
    : '(nenhuma mensagem anterior nesta conversa)';

  const userPrompt = `TIPO DE ATENDIMENTO: ${type}
INSTRUÇÃO: ${typeInstruction}

HISTÓRICO DA CONVERSA (leia com atenção antes de responder, para não repetir perguntas já respondidas nem se apresentar de novo):
${historicoFormatado}

CONTEXTO (dados do sistema):
${context}

ÚLTIMA MENSAGEM DO CLIENTE (a que você está respondendo agora):
"${clientMessage}"

Redija a resposta da Iara considerando tudo que já foi dito na conversa. Máximo 3 parágrafos curtos. Linguagem simples. Nunca dar parecer jurídico. Nunca mencionar valores. Nunca repita uma pergunta cuja resposta já está no histórico acima.`;

  const corrections = getRecentCorrections(20);
  const correctionsSection = corrections.length > 0
    ? `\n\nCORREÇÕES ANTERIORES (aprenda com estas edições de Wesley — prefira o estilo corrigido):\n` +
      corrections.map((c, i) => `${i + 1}. Original: "${c.original.slice(0, 120)}"\n   Corrigido: "${c.corrected.slice(0, 120)}"`).join('\n')
    : '';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: buildSystemPrompt(genero) + correctionsSection,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const block = response.content[0];
  const draft = block && block.type === 'text' ? block.text : '';
  return aplicarGlossario(draft);
}

export async function parseCommand(commandText: string, context: string): Promise<{
  action: string;
  params: Record<string, any>;
  response: string;
}> {
  const prompt = `Você é o interpretador de comandos da secretária Iara.

Contexto do sistema:
${context}

Comando recebido de Wesley:
"${commandText}"

Accões disponíveis:
- send_message: {phone, message} — enviar mensagem para um contato. Se o comando começar com "Responda:", "Manda:", "Envia:" ou similar, a ação é SEMPRE send_message e o "message" é todo o texto que vem depois dos dois-pontos, palavra por palavra (não resuma, não reescreva). Se o contexto não citar um telefone específico, use o "activePhone" do contexto como phone.
- update_trello: {cardName, status, note} — atualizar card no Trello
- create_lead: {name, phone, summary} — criar lead no Trello
- search_process: {query} — buscar processo no DJEN/Trello
- pause_contact: {phone} — pausar IA para um contato
- resume_contact: {phone} — retomar IA para um contato
- day_summary: {} — gerar resumo do dia
- save_drive_note: {phone, note} — salvar nota no Drive
- set_instruction: {phone, instruction} — definir instrução especial para contato
- schedule_followup: {phone, message, days} — agendar follow-up
- unknown: {} — só use esta ação se realmente não for possível identificar nenhuma das ações acima

Exemplo: comando 'Responda: ok, vou verificar' com activePhone "5544999998888" no contexto vira:
{"action": "send_message", "params": {"phone": "5544999998888", "message": "ok, vou verificar"}, "response": "Mensagem enviada"}

Responda APENAS com o JSON puro, sem markdown, sem \`\`\`, sem texto antes ou depois:
{"action": "nome_da_ação", "params": {...}, "response": "confirmação em português"}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = response.content[0];
  const text = block && block.type === 'text' ? block.text : '{}';
  try {
    // Remove markdown fences (```json ... ```) caso o modelo os inclua mesmo sendo instruído a não fazê-lo
    const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
  } catch (err) {
    console.error('[parseCommand] falha ao parsear resposta:', text);
    return { action: 'unknown', params: {}, response: 'Não entendi o comando. Tente novamente.' };
  }
}
