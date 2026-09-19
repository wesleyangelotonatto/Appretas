import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT_IARA, aplicarGlossario } from '../persona';
import type { ClassificationType } from '../classifier/groq';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TYPE_INSTRUCTIONS: Record<string, string> = {
  PROCESSO_ATIVO: `O cliente é um cliente ativo com processo em andamento. Informe sobre o andamento de forma simples e clara, usando os dados do DJEN e Trello fornecidos. Se não houver dados, diga que vai verificar com o Dr. Wesley.`,
  NOVO_CASO_CLIENTE_ANTIGO: `O cliente é um cliente já atendido anteriormente, mas está trazendo um assunto novo. Recepcione-o, pergunte sobre o novo assunto e diga que vai repassar ao Dr. Wesley.`,
  LEAD_NOVO: `É um potencial novo cliente. Recepcione formalmente, pergunte o nome, o que precisa e peça para detalhar a situação. Se for caso jurídico, peça que envie documentos se tiver.`,
  NEGOCIO_PARTICULAR: `É um contato de negócio (não-advocatício). Recepcione educadamente, anote a pauta e diga que vai repassar ao Dr. Wesley.`,
  AMIGO_PESSOAL: `É uma mensagem de amigo/pessoal. Responda de forma leve e informal, dizendo que Wesley está em atendimento e vai retornar.`,
  INSTITUCIONAL: `É um contato institucional (OAB, Maçonaria, etc.). Resposta MUITO formal. Recepcione, anote a pauta e diga que Dr. Wesley retornará em breve.`,
  DESCONHECIDO: `Não foi possível classificar o contato. Faça a saudação padrão e pergunte como pode ajudar.`,
};

export async function draftResponse(
  type: ClassificationType | string,
  clientMessage: string,
  context: string
): Promise<string> {
  const typeInstruction = TYPE_INSTRUCTIONS[type] || TYPE_INSTRUCTIONS['DESCONHECIDO'];

  const userPrompt = `TIPO DE ATENDIMENTO: ${type}
INSTRUÇÃO: ${typeInstruction}

CONTEXTO (dados do sistema):
${context}

MENSAGEM DO CLIENTE:
"${clientMessage}"

Redija a resposta da Iara. Máximo 3 parágrafos curtos. Linguagem simples. Nunca dar parecer jurídico. Nunca mencionar valores.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: SYSTEM_PROMPT_IARA,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const draft = response.content[0].type === 'text' ? response.content[0].text : '';
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
- send_message: {phone, message} — enviar mensagem para um contato
- update_trello: {cardName, status, note} — atualizar card no Trello
- create_lead: {name, phone, summary} — criar lead no Trello
- search_process: {query} — buscar processo no DJEN/Trello
- pause_contact: {phone} — pausar IA para um contato
- resume_contact: {phone} — retomar IA para um contato
- day_summary: {} — gerar resumo do dia
- save_drive_note: {phone, note} — salvar nota no Drive
- set_instruction: {phone, instruction} — definir instrução especial para contato
- schedule_followup: {phone, message, days} — agendar follow-up
- unknown: {} — não entendeu o comando

Responda com JSON:
{"action": "nome_da_ação", "params": {...}, "response": "confirmação em português"}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { action: 'unknown', params: {}, response: 'Não entendi o comando. Tente novamente.' };
  }
}
