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
  return `Olá. Aqui é a *Iara*, *secretária* do Dr. Wesley Veiga. Estou disponível para receber sua mensagem e repassá-la ao Dr. Wesley. Como posso ${ajudarSufixo(g)}?`;
}

export const MSG_FORA_HORARIO = `Aqui é a *secretária* do doutor Wesley. Ele trabalha em horário comercial (08:30 às 17:00 - Seg a Sex). Em casos graves como prisão, acidente ou busca e apreensão, ligue várias vezes no telefone do Dr. Wesley diretamente. Caso contrário, retornaremos na próxima janela de atendimento ou me conta aqui o que precisa.`;

export function MSG_ENCERRAMENTO(g: Genero = 'N'): string {
  return `Há mais alguma coisa em que eu possa ${ajudarSufixo(g)} ou repassar ao Dr. Wesley?`;
}

export const MSG_PROCESSO_NAO_ENCONTRADO = `Estou verificando o andamento com o Dr. Wesley e retorno em breve.`;

export const MSG_URGENCIA_AGUARDAR = `Sua mensagem foi recebida e a *Iara* está verificando com o Dr. Wesley. Retornaremos em breve.`;

export const MSG_PEDIR_ADVOGADO = `Vou comunicar ao Dr. Wesley sua solicitação. A *Iara* anotou e ele retornará assim que possível.`;

// Pergunta qualificadora obrigatória para localizar processo: nome completo (se faltar) + contra quem (obrigatório) + número (recomendável)
export function MSG_PEDIR_DADOS_PROCESSO(temNome: boolean): string {
  const pedirNome = temNome ? '' : 'Para localizar o processo, preciso do nome completo da parte. ';
  return `${pedirNome}Preciso saber contra quem é o processo e, de preferência, o número. Caso não tenha essas informações, preciso aguardar o Dr. Wesley me responder.`;
}

export function MSG_RECUSA_SECRETARIA(g: Genero = 'N'): string {
  return `Compreendo. A *Iara* vai informar ao Dr. Wesley que ${tratamento(g)} deseja falar diretamente com ele. Assim que possível, ele entrará em contato.`;
}

export const MSG_AMIGO = `Olá. Aqui é a *Iara*, *secretária* do Dr. Wesley. Parece que sua mensagem é de cunho pessoal. Caso eu esteja enganada, por favor me corrija. Vou repassar ao Dr. Wesley para que ele retorne quando disponível.`;

export const MSG_NENHUMA_MOVIMENTACAO_IMPORTANTE = `Houve uma movimentação simples no processo, sem nada de urgente. Estamos avisando para que saiba que ele está andando normalmente.`;

export const HORARIO_ATENDIMENTO = {
  semana: { inicio: 8, inicioMinuto: 30, fim: 17 },
  sabado: false,
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

// Expressões de entusiasmo forçado — nunca soar falso ou artificial
const FRASES_PROIBIDAS = [
  /fico\s+feliz\s+em\s+ajud[aá][-\s]?l[oa]?/gi,
  /ficarei\s+feliz\s+em\s+ajud[aá][-\s]?l[oa]?/gi,
  /(?:é|será)\s+um\s+prazer\s+(?:em\s+)?ajud[aá][-\s]?l[oa]?/gi,
  /com\s+prazer\s+(?:em\s+)?ajud[aá][-\s]?l[oa]?/gi,
  /que\s+bom\s+falar\s+com\s+(?:você|o\s+senhor|a\s+senhora)/gi,
  /adorar[ia]a?\s+ajud[aá][-\s]?l[oa]?/gi,
  /fico\s+à\s+disposição\s+com\s+muito\s+prazer/gi,
];

// Detecta se a IA sugeriu que o cliente ligue/contate o Dr. Wesley diretamente (nunca permitido:
// a resolução deve ser sempre puxada para a Iara, nunca terceirizada para o cliente)
const SUGESTAO_LIGAR_DIRETO_RE = /(ligue|liga|entre em contato|contate|procure|fale)\s+(diretamente\s+)?(com\s+o\s+|com\s+)?(o\s+)?(dr\.?\s*wesley|doutor\s*wesley|ele)\s*(diretamente\s*)?(pelo\s+telefone|no\s+telefone|por\s+telefone)?/i;

export const MSG_FALLBACK_COBRANCA_PRAZO = `Entendo a preocupação. O Dr. Wesley atende muitos casos e clientes, por isso o retorno costuma levar até 1 dia útil. Vou continuar acompanhando e cobrando internamente para que ele responda o quanto antes.`;

export function aplicarGlossario(texto: string): string {
  // Se a IA sugeriu que o cliente ligue/contate o Dr. Wesley diretamente, descarta a
  // mensagem inteira e usa a resposta padrão segura (a resolução nunca é terceirizada ao cliente)
  if (SUGESTAO_LIGAR_DIRETO_RE.test(texto)) {
    return MSG_FALLBACK_COBRANCA_PRAZO;
  }

  let resultado = texto;
  for (const [proibido, correto] of Object.entries(GLOSSARIO)) {
    const regex = new RegExp(`\\b${proibido}\\b`, 'gi');
    resultado = resultado.replace(regex, correto);
  }
  for (const re of FRASES_PROIBIDAS) {
    resultado = resultado.replace(re, '').replace(/\s{2,}/g, ' ').trim();
  }
  // Remove tags HTML (a IA às vezes gera <br> em vez de quebra de linha real)
  resultado = resultado.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '');
  // Remove saudação/autoapresentação redundante no início (a saudação do dia já é enviada
  // separadamente pelo sistema via SAUDACAO; a IA não deve repeti-la em cada resposta)
  resultado = resultado
    .replace(/^(?:bom\s*dia|boa\s*tarde|boa\s*noite|olá)[,.!\s]*/i, '')
    .replace(/^aqui\s+é\s+a\s+\*?iara\*?,?\s*\*?secretária\*?\s+do\s+dr\.?\s*wesley[^.!\n]*[.!]\s*/i, '')
    .trimStart();
  resultado = resultado.charAt(0).toUpperCase() + resultado.slice(1);
  // Remove travessões e substitui por vírgula
  resultado = resultado.replace(/\s*—\s*/g, ', ');
  // Aplica negrito ao nome Iara e ao cargo secretária (formato WhatsApp)
  resultado = resultado.replace(/\bIara\b/g, '*Iara*');
  resultado = resultado.replace(/\bsecretária\b/gi, '*secretária*');
  // Evita negrito duplo (****Iara****)
  resultado = resultado.replace(/\*{2,}(Iara|secretária)\*{2,}/gi, (_, w) => `*${w}*`);
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
5. Nunca prometer retorno com prazo curto e específico ("ligo em 1 hora", "retorno em 10 minutos"). Quando o cliente cobrar prazo ou demora, explique que o Dr. Wesley atende muitos casos e clientes e que o retorno costuma ocorrer em até 1 dia útil
6. Usar sempre linguagem simples, nunca técnico-jurídica
7. Nunca usar: vara, câmara, citação, procedente, improcedente, instrução processual, conciliação, alvará
8. Nunca usar expressões de entusiasmo forçado ou artificial: "fico feliz em ajudar", "é um prazer ajudar", "ficarei feliz", "com prazer", "que bom falar com você", "adoraria ajudar" ou qualquer variação. O tom é profissional e cordial, nunca efusivo ou falso
9. Nunca usar tags HTML como <br>, <b>, <i> etc. Para separar parágrafos, use apenas quebra de linha simples (linha em branco)
10. Nunca inicie a resposta com saudação ("Bom dia", "Boa tarde", "Boa noite", "Olá") nem com autoapresentação ("Aqui é a Iara, secretária do Dr. Wesley"). Isso já foi feito uma única vez pelo sistema no início da conversa do dia. Vá direto ao assunto da mensagem do cliente
11. JAMAIS sugerir, em qualquer hipótese, que o cliente ligue ou entre em contato diretamente com o Dr. Wesley pelo telefone. A resolução é sempre puxada para a *Iara*: se o cliente cobrar demora, explique que o Dr. Wesley atende muitos casos e clientes, que o retorno ocorre em até 1 dia útil, e que ela mesma vai continuar acompanhando e cobrando internamente. Nunca terceirizar o contato para o cliente

LINGUAGEM E TOM:
- Tom formal e profissional, como secretária de escritório de advocacia conceituado
- Nunca use emojis de nenhum tipo
- Nunca use travessão (—) em nenhuma circunstância; use vírgula ou ponto
- Nunca use gírias, expressões informais, abreviações ou linguagem coloquial
- Nunca use: "né", "tá", "pra", "vc", "rsrs", "haha", "tudo bem?", "oi!"
- Nunca termine frases com "tá bem?", "ok?" ou similares
- Ao se referir a si mesma, escreva sempre *Iara* (com asteriscos para negrito no WhatsApp)
- Ao mencionar seu cargo, escreva sempre *secretária* (com asteriscos para negrito no WhatsApp)
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
