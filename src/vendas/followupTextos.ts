// Textos-base do follow-up (Anexo A do plano, A.3 e A.4, e os das demais etapas no
// mesmo estilo). São o PADRÃO: o Wesley edita em "Follow-up" no painel da Iara.
// Lacunas entre chaves são preenchidas com o que está na conversa:
// {nome} {produto} {documento} {ponto} {data}. Sem dado verdadeiro para uma lacuna,
// o toque vai para aprovação em vez de sair.
export interface ToqueTexto { dia: number; texto: string; depois?: string }

export const ROTULO_ETAPA: Record<string, string> = {
  '01': '01 Novo Lead', '04': '04 Agendar/Ligar/Reunir', '05': '05 Aguard. Docs', '08': '08 Proposta Enviada',
  '09': '09 Decidindo', '10': '10 Contrato/Procuração', '12': '12 Retornar em',
};

export const TEXTOS_PADRAO: Record<string, ToqueTexto[]> = {
  '01': [
    { dia: 1, texto: 'Oi, seu {nome}! Ontem a gente parou na parte {ponto}. Ficou alguma dúvida? Pode me responder por áudio, se for mais fácil.' },
    { dia: 3, texto: 'Seu {nome}, lembrei do seu caso. Nesses casos de {produto}, quanto antes a gente olha os papéis, mais chance de não perder prazo. Se tiver uma foto {documento}, já ajuda bastante.' },
    { dia: 7, texto: 'Seu {nome}, o Dr. Wesley me orientou a falar com o senhor de novo. Tivemos um caso parecido aqui na região, de um produtor que também ouviu que não tinha jeito. Quer que eu te conte como ficou?' },
    { dia: 14, texto: 'Seu {nome}, só pra o senhor ficar sabendo: pelo que me contou, o prazo pra fazer alguma coisa vai até mais ou menos {data}. Depois disso fica mais difícil. Ainda quer que a gente veja o seu caso?' },
    { dia: 21, texto: 'Seu {nome}, vou parar de te incomodar, tá? Sei que a lida é corrida. Se um dia quiser retomar, é só mandar um oi aqui que eu lembro do seu caso. Fico à disposição.', depois: '13' },
  ],
  '09': [
    { dia: 2, texto: 'Oi, seu {nome}! O senhor conseguiu pensar na proposta? O que ainda está pesando mais pra decidir?' },
    { dia: 5, texto: 'Seu {nome}, lembrei de uma coisa que pode ajudar: o Dr. Wesley pode te mandar uma decisão de um caso parecido que o escritório ganhou. E lembrando: a maior parte dos honorários só vem no final, se der resultado. Quer que eu peça pra ele?' },
    { dia: 7, texto: 'Seu {nome}, o Dr. Wesley pediu pra perguntar se o senhor não prefere conversar direto com ele, por ligação, uns 15 minutinhos. Qual o melhor dia e horário pro senhor?', depois: '04' },
    { dia: 14, texto: 'Seu {nome}, o Dr. Wesley me pediu pra avisar: {data}. Depois disso não dá mais pra manter. Vamos seguir?' },
    { dia: 21, texto: 'Seu {nome}, não quero ficar insistindo. Se o senhor preferir deixar pra outra hora, me fala uma data que eu volto a falar. E se mudar de ideia antes, é só me chamar aqui.', depois: '13' },
  ],
  '04': [
    { dia: 1, texto: 'Oi, seu {nome}! O Dr. Wesley quer muito conversar com o senhor sobre o caso. Qual dia e horário fica melhor essa semana, de manhã ou à tarde?' },
    { dia: 3, texto: 'Seu {nome}, consegui um horário com o Dr. Wesley. Me diz um dia bom pro senhor que eu já deixo marcado, é rapidinho.' },
  ],
  '05': [
    { dia: 2, texto: 'Oi, seu {nome}! Pra o Dr. Wesley analisar o seu caso, ainda falta {documento}. Pode ser foto pelo celular mesmo.' },
    { dia: 4, texto: 'Seu {nome}, conseguiu ver {documento}? Se estiver com dificuldade pra achar, me fala que eu explico onde costuma ficar.' },
    { dia: 6, texto: 'Seu {nome}, lembrando do {documento}. Com ele em mãos, o Dr. Wesley já consegue te dizer o caminho do seu caso.' },
  ],
  '08': [
    { dia: 1, texto: 'Oi, seu {nome}! O senhor recebeu a proposta do Dr. Wesley? Ficou alguma dúvida que eu possa explicar?' },
    { dia: 3, texto: 'Seu {nome}, sobre a proposta: a maior parte dos honorários só vem no final, se der resultado. O que o senhor achou?' },
    { dia: 7, texto: 'Seu {nome}, o Dr. Wesley perguntou da proposta. Se preferir, ele explica por ligação em 15 minutinhos. Qual horário é bom pro senhor?' },
  ],
  '10': [
    { dia: 1, texto: 'Oi, seu {nome}! Conseguiu assinar o contrato e a procuração? Se tiver qualquer dificuldade, me fala que eu ajudo.' },
    { dia: 3, texto: 'Seu {nome}, assim que o contrato e a procuração voltarem assinados, o Dr. Wesley já começa a cuidar do seu caso.' },
    { dia: 7, texto: 'Seu {nome}, passando pra lembrar da assinatura do contrato e da procuração. Quer que eu te explique o passo a passo?' },
  ],
  '12': [
    { dia: 0, texto: 'Oi, seu {nome}! Como combinado, estou voltando a falar sobre o seu caso de {produto}. Podemos retomar?' },
  ],
};
