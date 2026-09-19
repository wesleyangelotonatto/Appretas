import Groq from 'groq-sdk';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

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
}

interface ClassifyResult {
  type: ClassificationType;
  confidence: number;
  intent: string;
}

export async function classifyContact(input: ClassifyInput): Promise<ClassifyResult> {
  const prompt = `Você é um classificador de mensagens WhatsApp de um escritório de advocacia.

Dados do contato:
- Telefone: ${input.phone}
- Cadastrado no sistema: ${input.found ? 'SIM' : 'NÃO'}${input.name ? ` (Nome: ${input.name})` : ''}
- Processos vinculados: ${input.processes?.join(', ') || 'nenhum'}
${input.customInstruction ? `- Instrução especial: ${input.customInstruction}` : ''}

Mensagem recebida: "${input.messageText}"

Classifique em EXATAMENTE um dos tipos abaixo:
- PROCESSO_ATIVO: cliente cadastrado perguntando sobre processo em andamento
- NOVO_CASO_CLIENTE_ANTIGO: cliente cadastrado com assunto novo/diferente
- LEAD_NOVO: número desconhecido buscando serviços jurídicos
- NEGOCIO_PARTICULAR: parceiro/fornecedor/negócio não-advocatício
- AMIGO_PESSOAL: conversa informal/pessoal sem cunho jurídico
- INSTITUCIONAL: OAB, Maçonaria, conselho, associação
- DESCONHECIDO: não é possível classificar com confiança

Responda APENAS com JSON válido:
{"type": "TIPO", "confidence": 0.0-1.0, "intent": "resumo do que o contato quer"}`;

  const response = await groq.chat.completions.create({
    model: 'llama3-70b-8192',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 200,
  });

  const text = response.choices[0]?.message?.content || '{}';
  try {
    const result = JSON.parse(text);
    if (result.confidence < 0.7) result.type = 'DESCONHECIDO';
    return result as ClassifyResult;
  } catch {
    return { type: 'DESCONHECIDO', confidence: 0, intent: 'falha na classificação' };
  }
}

export async function transcribeAudio(mediaUrl: string): Promise<string> {
  try {
    const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    const tmpPath = path.join('/tmp', `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tmpPath, response.data);

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
