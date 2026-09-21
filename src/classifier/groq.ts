import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export type ClassificationType =
  | 'PROCESSO_ATIVO'
  | 'NOVO_CASO_CLIENTE_ANTIGO'
  | 'LEAD_NOVO'
  | 'NEGOCIO_PARTICULAR'
  | 'AMIGO_PESSOAL'
  | 'INSTITUCIONAL'
  | 'DESCONHECIDO';

interface ClassifyInput {
  phone: string;
  found: boolean;
  name?: string;
  processes?: string[];
  messageText: string;
  customInstruction?: string | null;
  historico?: Array<{ role: string; body: string }>;
}

interface ClassifyResult {
  type: ClassificationType;
  confidence: number;
  intent: string;
}

export async function classifyContact(input: ClassifyInput): Promise<ClassifyResult> {
  const historicoFormatado = input.historico?.length
    ? input.historico.map(m => `${m.role === 'client' ? 'Cliente' : m.role === 'iara' ? 'Iara' : 'Wesley'}: ${m.body}`).join('\n')
    : '(sem mensagens anteriores)';

  const prompt = `Você é um classificador de mensagens WhatsApp de um escritório de advocacia.

Dados do contato:
- Telefone: ${input.phone}
- Cadastrado no sistema: ${input.found ? 'SIM' : 'NÃO'}${input.name ? ` (Nome: ${input.name})` : ''}
- Processos vinculados: ${input.processes?.join(', ') || 'nenhum'}
${input.customInstruction ? `- Instrução especial: ${input.customInstruction}` : ''}

HISTÓRICO RECENTE DA CONVERSA (use para entender o contexto — a última mensagem pode só fazer sentido à luz do que já foi dito):
${historicoFormatado}

ÚLTIMA MENSAGEM DO CLIENTE (a que você deve classificar): "${input.messageText}"

Classifique em EXATAMENTE um dos tipos abaixo:
- PROCESSO_ATIVO: cliente está trazendo ou detalhando dados de um caso específico para que ele seja localizado — pode ser um PROCESSO judicial (nome, parte contrária, número) OU um CONTRATO/serviço não-judicial (nome, com quem é o contrato, número se houver). Nem todo caso do escritório é um processo judicial — pode ser elaboração/revisão de contrato, consultoria, ou outro serviço contratado
- NOVO_CASO_CLIENTE_ANTIGO: cliente cadastrado com assunto novo/diferente
- LEAD_NOVO: número desconhecido buscando serviços jurídicos
- NEGOCIO_PARTICULAR: parceiro/fornecedor/negócio não-advocatício
- AMIGO_PESSOAL: conversa informal/pessoal sem cunho jurídico
- INSTITUCIONAL: OAB, Maçonaria, conselho, associação
- DESCONHECIDO: mensagem de acompanhamento/cobrança de prazo, reclamação sobre demora, agradecimento ou qualquer coisa que NÃO seja o cliente fornecendo dados novos do processo/contrato (ex.: "quanto tempo vai demorar", "por que ele não responde", "fico no aguardo")

IMPORTANTE: se a mensagem for apenas uma cobrança de resposta, reclamação sobre demora ou agradecimento (não está fornecendo novos dados do processo), classifique como DESCONHECIDO, mesmo que o histórico seja sobre um processo.

Responda APENAS com JSON válido:
{"type": "TIPO", "confidence": 0.0-1.0, "intent": "resumo do que o contato quer"}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = message.content[0];
    const text = block && block.type === 'text' ? block.text : '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    if (result.confidence < 0.7) result.type = 'DESCONHECIDO';
    return result as ClassifyResult;
  } catch (err) {
    console.error('[classifier] erro na classificação:', err);
    return { type: 'DESCONHECIDO', confidence: 0, intent: 'falha na classificação' };
  }
}

export async function transcribeAudio(mediaUrl?: string, base64?: string): Promise<string> {
  try {
    let audioBuffer: Buffer;
    if (base64) {
      audioBuffer = Buffer.from(base64, 'base64');
    } else if (mediaUrl) {
      const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
      audioBuffer = Buffer.from(response.data);
    } else {
      return '[Áudio recebido — sem conteúdo disponível]';
    }

    const tmpPath = path.join('/tmp', `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tmpPath, audioBuffer);

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-large-v3-turbo',
      language: 'pt',
    });

    fs.unlinkSync(tmpPath);
    return transcription.text;
  } catch (err) {
    console.error('[groq] erro ao transcrever áudio:', err);
    return '[Áudio recebido — não foi possível transcrever]';
  }
}
