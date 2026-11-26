import Anthropic from '@anthropic-ai/sdk';

// Ponto único de chamada aos modelos do Claude. O modelo de cada função vem de
// variável de ambiente, para trocar sem mexer em código:
//   MODELO_RAPIDO   — tarefas triviais (classificação, checagens, JSON curto)
//   MODELO_RESPOSTA — respostas ao cliente, comandos e resumos
export type FuncaoIA = 'rapido' | 'resposta';

const PADRAO: Record<FuncaoIA, string> = {
  rapido: 'claude-haiku-5-5',
  resposta: 'claude-sonnet-5-5',
};

// Modelos anteriores, usados só se o modelo configurado rejeitar a chamada
const RESERVA: Record<FuncaoIA, string> = {
  rapido: 'claude-haiku-4-5',
  resposta: 'claude-sonnet-4-6',
};

export function modeloDa(funcao: FuncaoIA): string {
  const env = funcao === 'rapido' ? process.env.MODELO_RAPIDO : process.env.MODELO_RESPOSTA;
  return (env || '').trim() || PADRAO[funcao];
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Os modelos 5.x raciocinam antes de responder por padrão. Nas tarefas da Iara as
// respostas são curtas (às vezes 10 a 50 tokens): o raciocínio consumiria o limite
// e a resposta sairia vazia. Por isso o raciocínio fica desligado onde o modelo
// permite e o esforço vai para o mínimo.
function ajustesDoModelo(modelo: string): Record<string, unknown> {
  const desligado = { thinking: { type: 'disabled' }, output_config: { effort: 'low' } };
  if (modelo.includes('sonnet-5-5')) return { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } };
  if (modelo.includes('opus-5-5') || modelo.includes('fable-5')) return { output_config: { effort: 'low' } };
  if (modelo.includes('haiku-5') || modelo.includes('sonnet-5') || modelo.includes('opus-5')) return desligado;
  return {}; // modelos 4.x: comportamento antigo, sem raciocínio
}

// Duração do cache da parte fixa das instruções: 1 hora por padrão (decisão de 26/11).
// A gravação de 1 h custa 2x; cada leitura dentro da hora custa 10%.
const CACHE_TTL: '5m' | '1h' = process.env.CACHE_TTL === '5m' ? '5m' : '1h';

interface Pedido {
  max_tokens: number;
  system?: string;
  messages: Anthropic.MessageParam[];
  // Guarda a parte fixa (system) em cache: nas chamadas seguintes ela custa ~10%.
  cacheSystem?: boolean;
}

export async function criarMensagem(funcao: FuncaoIA, pedido: Pedido): Promise<Anthropic.Message> {
  const modelo = modeloDa(funcao);
  const system = pedido.system
    ? (pedido.cacheSystem
        ? [{ type: 'text' as const, text: pedido.system, cache_control: { type: 'ephemeral' as const, ttl: CACHE_TTL } }]
        : pedido.system)
    : undefined;

  const chamar = (m: string) => client.messages.create({
    model: m,
    max_tokens: pedido.max_tokens,
    ...(system ? { system } : {}),
    messages: pedido.messages,
    ...ajustesDoModelo(m),
  } as Anthropic.MessageCreateParamsNonStreaming);

  let resposta: Anthropic.Message;
  let usado = modelo;
  try {
    resposta = await chamar(modelo);
  } catch (err) {
    // Se o modelo novo rejeitar a chamada (configuração ou modelo indisponível),
    // a Iara não para: repete uma vez no modelo anterior, que já funcionava.
    if (!(err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.PermissionDeniedError)) throw err;
    usado = RESERVA[funcao];
    if (usado === modelo) throw err;
    console.error(`[ia] ${modelo} rejeitou a chamada (${funcao}), usando ${usado}:`, err.message);
    resposta = await chamar(usado);
  }
  const modeloUsado = usado;

  if (resposta.stop_reason === 'refusal') {
    console.warn(`[ia] ${modeloUsado} recusou a solicitação (${funcao})`);
  }

  registrarUso(funcao, modeloUsado, resposta.usage);

  // Os chamadores leem content[0] como texto: deixa só os blocos de texto
  return { ...resposta, content: resposta.content.filter(b => b.type === 'text') };
}

function registrarUso(funcao: string, modelo: string, u: Anthropic.Usage) {
  import('./memory/db').then(({ registrarUsoIA }) => registrarUsoIA(
    funcao, modelo, u.input_tokens || 0, u.output_tokens || 0,
    u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0,
  )).catch(err => console.error('[ia] falha ao registrar uso:', err));
}

// Preço por milhão de tokens (entrada, saída), em dólares, para o relatório de custo
const PRECOS: Array<[RegExp, number, number]> = [
  [/haiku-5-5/, 0.10, 0.50],
  [/haiku-4-5/, 1, 5],
  [/sonnet-5/, 2, 10],
  [/sonnet-4/, 3, 15],
  [/opus-5-5/, 4, 20],
  [/opus/, 5, 25],
];

export function custoEstimado(modelo: string, entrada: number, saida: number, cacheLeitura: number, cacheEscrita: number): number {
  const p = PRECOS.find(([re]) => re.test(modelo));
  if (!p) return 0;
  const [, pe, ps] = p;
  const fatorEscrita = CACHE_TTL === '1h' ? 2 : 1.25;
  return (entrada * pe + cacheLeitura * pe * 0.1 + cacheEscrita * pe * fatorEscrita + saida * ps) / 1e6;
}
