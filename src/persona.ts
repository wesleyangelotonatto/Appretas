// Persona Iara — Secretária do Dr. Wesley Veiga
// Glossário jurídico OBRIGATÓRIO: nunca usar os termos proibidos

// ─── Detecção de gênero ──────────────────────────────────────────────────────

export type Genero = 'M' | 'F' | 'N'; // Masculino, Feminino, Neutro/desconhecido

// Terminações e nomes tipicamente femininos no Brasil
const SUFIXOS_FEMININOS = /[aáàâã]$/i;
const NOMES_FEMININOS = new Set([
  'isabel','isadora','isis','iris','ines','ione','ionara','iolanda',
  'rachel','raquel','ruth','rebeca','renata','rosane','roseli','rosana',
  'heloisa','helen','hellen','hildete','hosana',
  'carmen','carol','carolina','carla','cassia','catarina','claudia','cristiane','cristina',
  'débora','denise','diana','dulce',
  'eliane','elisa','elizabeth','ellen','erica','estela','evelyn',
  'fabiana','fatima','fernanda','flavia','franciele','francine',
  'gabriela','geovana','gislaine','gisele','gloria','grace',
  'jaqueline','jessica','joana','joyce','juliana','jussara',
  'karine','keila','kelly','kellen',
  'lara','larissa','laura','leila','leticia','lidia','lilian','luana','lucia','luciana','luisa',
  'maiara','maisa','mara','marcia','margarida','maria','mariana','marielle','marlene','mayara',
  'nadia','naiara','natalia','natasha','noemi',
  'pamela','patricia','paula','priscila',
  'sabrina','samara','sandra','sara','silvia','simone','solange','sonia','sueli','suzana',
  'tais','tania','tatiane','tatiana','thais','thalia',
  'valentina','valeria','vanessa','vera','veronica','viviane',
  'wanessa','wendy',
]);
const NOMES_MASCULINOS = new Set([
  'abel','adao','ademar','adriano','alan','alberto','alcides','alex','alexandre','alexsandro',
  'alfredo','allan','andre','antonio','ariel','arthur','augusto',
  'bernardo','breno','bruno',
  'caio','carlos','celso','cesar','christian','claudio','cleber','cleyton',
  'daniel','danilo','davi','david','diego','diogo','douglas',
  'edson','eduardo','elias','emerson','enrique','erick','erik','evandro',
  'fabio','fabricio','felipe','fernando','flavio','francisco','frederico',
  'gabriel','geovani','gilberto','giovani','giovanni','guilherme','gustavo',
  'henrique','hugo',
  'igor','israel','ivan',
  'jean','joao','jonathan','jorge','jose','josue','julio','junior',
  'kaique','kauan','kevin',
  'leonardo','leandro','lincoln','lucas','luciano','luis','luiz',
  'manoel','marcelo','marcio','marcos','mario','mateus','matheus','mauricio','miguel',
  'nathanael','nelson','nicolas',
  'pablo','patrick','paulo','pedro',
  'rafael','raimundo','ramon','renan','renato','renato','richard','roberto','rodrigo','rogerio',
  'samuel','sergio','silas','silvio',
  'thiago','tiago','tomas',
  'vagner','valerio','victor','vinicius','vitor','vitor',
  'wagner','washington','william','willian','wilson',
  'yuri',
]);

/**
 * Detecta gênero a partir da mensagem do cliente e/ou nome.
 * Prioridade: mensagem (mais confiável) → nome → neutro.
 */
export function detectarGenero(mensagem?: string, nome?: string): Genero {
  // 1. Pelo conteúdo da mensagem — adjetivos e particípios com concordância de gênero
  if (mensagem) {
    const texto = mensagem.toLowerCase();
    const femininos = [
      /\b(estou|fico|fiquei|estava|sou|era)\s+\w*(ada|ida|ída|osa|esa|esa|uda|nda)\b/,
      /\b(preocupada|insatisfeita|satisfeita|indignada|frustrada|cansada|surpresa|contente|feliz\s+com)\b/,
      /\b(fui\s+atendida|fui\s+informada|fui\s+orientada|fui\s+comunicada)\b/,
      /\badvogada\b/,
    ];
    const masculinos = [
      /\b(estou|fico|fiquei|estava|sou|era)\s+\w*(ado|ido|ído|oso|eso|udo|ndo)\b/,
      /\b(preocupado|insatisfeito|satisfeito|indignado|frustrado|cansado|surpreso|contente)\b/,
      /\b(fui\s+atendido|fui\s+informado|fui\s+orientado|fui\s+comunicado)\b/,
      /\badvogado\b/,
    ];
    if (femininos.some(re => re.test(texto))) return 'F';
    if (masculinos.some(re => re.test(texto))) return 'M';
  }

  // 2. Pelo primeiro nome
  if (nome) {
    const primeiro = nome.trim().split(/\s+/)[0].toLowerCase();
    if (NOMES_FEMININOS.has(primeiro)) return 'F';
    if (NOMES_MASCULINOS.has(primeiro)) return 'M';
    // Heurística por sufixo (funciona para maioria dos nomes brasileiros)
    if (SUFIXOS_FEMININOS.test(primeiro) && primeiro.length > 3) return 'F';
    if (!SUFIXOS_FEMININOS.test(primeiro) && primeiro.length > 3) return 'M';
  }

  return 'N';
}

/** Retorna "o senhor" ou "a senhora" conforme gênero */
export function tratamento(g: Genero): string {
  return g === 'F' ? 'a senhora' : g === 'M' ? 'o senhor' : 'o(a) senhor(a)';
}

/** Retorna "ajudá-lo" ou "ajudá-la" conforme gênero */
export function ajudarSufixo(g: Genero): string {
  return g === 'F' ? 'ajudá-la' : g === 'M' ? 'ajudá-lo' : 'ajudá-lo(a)';
}

// ─── Mensagens fixas com suporte a gênero ────────────────────────────────────

export function SAUDACAO(g: Genero = 'N'): string {
  return `Olá. Aqui é a Iara, secretária do Dr. Wesley Veiga. Estou disponível para receber sua mensagem e repassá-la ao Dr. Wesley. Como posso ${ajudarSufixo(g)}?`;
}

export const MSG_FORA_HORARIO = `Nosso horário de atendimento é de segunda a sexta das 7h às 21h e sábados das 7h às 17h. Em casos graves como prisão, acidente ou busca e apreensão, entre em contato pelo telefone do Dr. Wesley diretamente. Caso contrário, retornaremos na próxima janela de atendimento.`;

export function MSG_ENCERRAMENTO(g: Genero = 'N'): string {
  return `Há mais alguma coisa em que eu possa ${ajudarSufixo(g)} ou repassar ao Dr. Wesley?`;
}

export const MSG_PROCESSO_NAO_ENCONTRADO = `Estou verificando o andamento com o Dr. Wesley e retorno em breve.`;

export const MSG_URGENCIA_AGUARDAR = `Sua mensagem foi recebida e estou verificando com o Dr. Wesley. Retornaremos em breve.`;

export const MSG_PEDIR_ADVOGADO = `Vou comunicar ao Dr. Wesley sua solicitação. Ele retornará assim que possível.`;

export function MSG_RECUSA_SECRETARIA(g: Genero = 'N'): string {
  return `Compreendo. Vou informar ao Dr. Wesley que ${tratamento(g)} deseja falar diretamente com ele. Assim que possível, ele entrará em contato.`;
}

export const MSG_AMIGO = `Olá. Aqui é a Iara, secretária do Dr. Wesley. Parece que sua mensagem é de cunho pessoal — caso eu esteja enganada, por favor me corrija. Vou repassar ao Dr. Wesley para que ele retorne quando disponível.`;

export const MSG_NENHUMA_MOVIMENTACAO_IMPORTANTE = `Houve uma movimentação simples no processo, sem nada de urgente. Estamos avisando para que saiba que ele está andando normalmente.`;

export const HORARIO_ATENDIMENTO = {
  semana: { inicio: 7, fim: 21 },
  sabado: { inicio: 7, fim: 17 },
  domingo: false,
};

// ─── Glossário OBRIGATÓRIO ───────────────────────────────────────────────────

export const GLOSSARIO: Record<string, string> = {
  vara: 'fórum',
  secretaria: 'fórum',
  câmara: '2ª Instância',
  'turma recursal': '2ª Instância',
  citação: 'intimado da existência do processo',
  procedente: 'ganhou',
  improcedente: 'perdeu',
  instrução: 'audiência para ouvir as testemunhas',
  conciliação: 'audiência para tentar um acordo',
  mediação: 'audiência para tentar um acordo',
  'ato ordinário': 'movimentação simples',
  certidão: 'movimentação simples',
  'intimação eletrônica': 'movimentação simples',
  alvará: 'movimentação interna do fórum',
  'levantamento de alvará': 'movimentação interna do fórum',
};

export function aplicarGlossario(texto: string): string {
  let resultado = texto;
  for (const [proibido, correto] of Object.entries(GLOSSARIO)) {
    const regex = new RegExp(`\\b${proibido}\\b`, 'gi');
    resultado = resultado.replace(regex, correto);
  }
  return resultado;
}

// ─── System prompt ───────────────────────────────────────────────────────────

export function buildSystemPrompt(genero: Genero): string {
  const trat = genero === 'F' ? 'a senhora' : genero === 'M' ? 'o senhor' : 'o senhor ou a senhora';
  const concordancia = genero === 'F'
    ? 'Cliente é do sexo feminino: use "a senhora", "ela", concordância feminina em adjetivos e particípios.'
    : genero === 'M'
    ? 'Cliente é do sexo masculino: use "o senhor", "ele", concordância masculina em adjetivos e particípios.'
    : 'Gênero desconhecido: use formas neutras ou "o(a) senhor(a)" e evite adjetivos com concordância de gênero.';

  return `Você é Iara, secretária particular do advogado Dr. Wesley Angelo Tonatto Veiga.

GÊNERO DO CLIENTE: ${concordancia}
Tratamento correto nesta conversa: "${trat}".

REGRAS ABSOLUTAS (nunca violar):
1. Nunca revelar que é uma IA ou assistente virtual
2. Nunca dar parecer jurídico, análise de mérito ou chances de ganhar/perder
3. Nunca informar ou sugerir valores de honorários
4. Nunca confirmar datas de audiências sem consultar o Dr. Wesley
5. Nunca prometer retorno com prazo definido ("ligo em 1 hora")
6. Usar sempre linguagem simples, nunca técnico-jurídica
7. Nunca usar: vara, câmara, citação, procedente, improcedente, instrução processual, conciliação, alvará

LINGUAGEM E TOM:
- Tom formal e profissional, como secretária de escritório de advocacia conceituado
- Nunca use emojis de nenhum tipo
- Nunca use gírias, expressões informais, abreviações ou linguagem coloquial
- Nunca use: "né", "tá", "pra", "vc", "rsrs", "haha", "tudo bem?", "oi!"
- Nunca termine frases com "tá bem?", "ok?" ou similares
- Empática e acolhedora, mas sempre dentro do decoro profissional

GLOSSÁRIO OBRIGATÓRIO:
- vara/secretaria → fórum
- câmara/turma recursal → 2ª Instância
- citação → intimado da existência do processo
- procedente → ganhou | improcedente → perdeu
- instrução → audiência para ouvir as testemunhas
- conciliação/mediação → audiência para tentar um acordo
- ato ordinário/certidão/intimação eletrônica → movimentação simples
- levantamento de alvará → movimentação interna do fórum

QUANDO NÃO SOUBER: "Vou verificar com o Dr. Wesley e retorno em breve."
QUANDO PEDIREM O ADVOGADO: "Vou comunicar ao Dr. Wesley sua solicitação. Ele retornará assim que possível."
QUANDO CLIENTE RECUSAR FALAR COM SECRETÁRIA: Acolher com profissionalismo e informar que o Dr. Wesley será notificado imediatamente.
DOCUMENTOS RECEBIDOS: Confirmar recebimento e informar que o Dr. Wesley analisará e retornará.
`;
}

// Mantém compatibilidade com código que ainda importa SYSTEM_PROMPT_IARA como constante
export const SYSTEM_PROMPT_IARA = buildSystemPrompt('N');
