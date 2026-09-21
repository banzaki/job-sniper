/**
 * Portuguese wording for the deterministic reasons produced by the basic filter. The stored reasons stay in
 * English (they are data); this only changes how they are shown. Anything unrecognized is returned unchanged.
 */
const RULES: { pattern: RegExp; render: (match: RegExpExecArray) => string }[] = [
  { pattern: /^status is (cancelled|closed)$/, render: (m) => `situação: ${m[1] === 'cancelled' ? 'cancelada' : 'encerrada'}` },
  { pattern: /^strong signals: (.+)$/, render: (m) => `sinais fortes: ${m[1]}` },
  { pattern: /^weak signals: (.+)$/, render: (m) => `sinais fracos: ${m[1]}` },
  { pattern: /^conflicting or advanced scope: (.+)$/, render: (m) => `escopo conflitante ou avançado: ${m[1]}` },
  { pattern: /^category "(.+)" is directly relevant$/, render: (m) => `categoria "${m[1]}" é diretamente relevante` },
  { pattern: /^category "(.+)" is outside the profile$/, render: (m) => `categoria "${m[1]}" está fora do perfil` },
  {
    pattern: /^category "(.+)" is outside the profile and there are no strong signals$/,
    render: (m) => `categoria "${m[1]}" está fora do perfil e não há sinais fortes`,
  },
  {
    pattern: /^category "(.+)" is not on the interest list and no interest signals were found$/,
    render: (m) => `categoria "${m[1]}" não está na lista de interesse e não há sinais de interesse`,
  },
  { pattern: /^status could not be confirmed as open$/, render: () => 'não foi possível confirmar que está aberta' },
  { pattern: /^only weak signals \((.+)\), not enough on their own$/, render: (m) => `apenas sinais fracos (${m[1]}), insuficientes sozinhos` },
  { pattern: /^broad category "(.+)" without a strong skill$/, render: (m) => `categoria ampla "${m[1]}" sem habilidade forte` },
  { pattern: /^no strong technical signal$/, render: () => 'sem sinal técnico forte' },
  {
    pattern: /^several compatible weak signals support the category$/,
    render: () => 'vários sinais fracos compatíveis reforçam a categoria',
  },
  {
    pattern: /^no interest signals, but the category is non-specific \("(.+)"\)$/,
    render: (m) => `sem sinais de interesse, mas a categoria é genérica ("${m[1]}")`,
  },
  {
    pattern: /^no interest signals, but the category is missing$/,
    render: () => 'sem sinais de interesse, e a categoria não foi informada',
  },
  // Jobs sources (engagement type and required location).
  {
    pattern: /^employment type: (freelance|contract|full time|part time|internship)( (not sent automatically))?$/,
    render: (m) => {
      const label = { freelance: 'freelance', contract: 'contrato', 'full time': 'tempo integral', 'part time': 'meio período', internship: 'estágio' }[m[1] as string];
      return `tipo de contratação: ${label}${m[2] ? ' (não enviada automaticamente)' : ''}`;
    },
  },
  { pattern: /^category "(.+)" is not technology$/, render: (m) => `categoria "${m[1]}" não é de tecnologia` },
  {
    pattern: /^reads like an ongoing team position, not a defined project$/,
    render: () => 'parece vaga contínua em equipe, não um projeto com entrega definida',
  },
  {
    pattern: /^strong skills appear only as tags, not in the title or description$/,
    render: () => 'as habilidades aparecem só como tags, não no título nem na descrição',
  },
  { pattern: /^prohibited or suspicious activity: the central goal is to fabricate views, clicks or impressions artificially$/, render: () => 'atividade proibida ou suspeita: o objetivo central é fabricar visualizações, cliques ou impressões artificialmente' },
  { pattern: /^crowded project \((\d+) proposals\): lowers the ranking$/, render: (m) => `concorrência alta (${m[1]} propostas): reduz a posição na fila` },
  { pattern: /^very crowded project \((\d+) proposals\): lowest priority in its group$/, render: (m) => `concorrência muito alta (${m[1]} propostas): última do seu grupo` },
  { pattern: /^(?:fixed budget|hourly rate) of about US\$ ([\d.]+)(\/h)? is below the US\$ (\d+)(\/h)? floor$/, render: (m) => `orçamento baixo: cerca de US$ ${brNumber(m[1]!)}${m[2] ?? ''} (referência: US$ ${m[3]}${m[4] ?? ''})` },
  { pattern: /^(?:fixed|hourly) budget range of about US\$ (.+?)(\/h)? crosses the US\$ (\d+)(\/h)? floor$/, render: (m) => `faixa de orçamento (cerca de US$ ${brNumber(m[1]!)}${m[2] ?? ''}) atravessa o piso de US$ ${m[3]}${m[4] ?? ''}` },
  { pattern: /^budget currency "(.+)" has no fresh USD conversion: not a top match$/, render: (m) => `sem taxa de câmbio recente para ${m[1]}: não pode ser match excelente` },
  { pattern: /^budget currency not stated: not a top match$/, render: () => 'moeda do orçamento não informada: não pode ser match excelente' },
  { pattern: /^top match: .+$/, render: () => 'match excelente: habilidade forte logo no início, escopo pequeno ou médio, descrição clara, orçamento acima do piso e pouca concorrência' },
  { pattern: /^back-end work is central: "(.+)" (in the title|at the start of the description) and no specific skill of the profile up front$/, render: (m) => `trabalho de back-end é central ("${m[1]}" ${m[2] === 'in the title' ? 'no título' : 'no início da descrição'}) e nenhuma habilidade específica do perfil em destaque` },
  { pattern: /^back-end work beside an available skill: "(.+)" (in the title|at the start of the description)$/, render: (m) => `trabalho de back-end ("${m[1]}" ${m[2] === 'in the title' ? 'no título' : 'no início da descrição'}) ao lado de uma habilidade disponível` },
  { pattern: /^no specific technical skill in the title or the start of the description$/, render: () => 'nenhuma habilidade técnica específica no título nem no início da descrição (só termos genéricos)' },
  { pattern: /^central skill outside the profile: "(.+)" in the title$/, render: (m) => `habilidade central fora do perfil: "${m[1]}" no título` },
  { pattern: /^central skill outside the profile: "(.+)" at the start of the description$/, render: (m) => `habilidade central fora do perfil: "${m[1]}" no início da descrição` },
  { pattern: /^essential skill outside the profile: "(.+)" beside an available skill$/, render: (m) => `habilidade essencial fora do perfil ("${m[1]}") ao lado de uma habilidade disponível` },
  { pattern: /^main task is not technical: "(.+)" in the title and no strong technical skill named there$/, render: (m) => `a tarefa principal não é técnica: "${m[1]}" no título, sem habilidade técnica forte` },
  {
    pattern: /^main task is not technical: "(.+)" in the title and no technical deliverable in the title or the start of the description$/,
    render: (m) => `a tarefa principal não é técnica: "${m[1]}" no título e nenhuma entrega técnica no título nem no início da descrição`,
  },
  {
    pattern: /^main task is not technical: "(.+)" at the start of the description and no technical deliverable in the title or there$/,
    render: (m) => `a tarefa principal não é técnica: "${m[1]}" no início da descrição e nenhuma entrega técnica`,
  },
  {
    pattern: /^title names non-technical work \("(.+)"\) but the description starts with a technical deliverable$/,
    render: (m) => `o título indica trabalho não técnico ("${m[1]}"), mas a descrição começa com uma entrega técnica`,
  },
  {
    pattern: /^technical deliverable is not clear in the title or the start of the description$/,
    render: () => 'a entrega técnica não está clara no título nem no início da descrição',
  },
  { pattern: /^very short deadline \(about (\d+) hours\): at most a review$/, render: (m) => `prazo muito curto (cerca de ${m[1]} horas): no máximo revisar` },
  { pattern: /^transactional scope \(payments or checkout\): at most a review$/, render: () => 'escopo transacional (pagamentos ou checkout): no máximo revisar' },
  { pattern: /^project language uncertain: the title is mostly in a non-Latin script but the source says "(.+)"$/, render: (m) => `idioma incerto: o título está em escrita não latina, mas a fonte declara "${m[1]}"` },
  { pattern: /^category "(.+)" is not technology, but a specific technical skill is named up front$/, render: (m) => `categoria "${m[1]}" não é de tecnologia, mas há uma habilidade técnica específica em destaque` },
  { pattern: /^project language "(.+)" is not one of the profile languages$/, render: (m) => `idioma do projeto ("${m[1]}") fora dos idiomas do perfil` },
  { pattern: /^employment type not stated$/, render: () => 'tipo de contratação não informado' },
  { pattern: /^employment type "(.+)" is not recognized$/, render: (m) => `tipo de contratação "${m[1]}" não reconhecido` },
  { pattern: /^location "(.+)" excludes residents of Brazil$/, render: (m) => `localização "${m[1]}" exclui quem mora no Brasil` },
  { pattern: /^location "(.+)" is ambiguous for a resident of Brazil$/, render: (m) => `localização "${m[1]}" é ambígua para quem mora no Brasil` },
  { pattern: /^location "(.+)" is compatible with residence in Brazil$/, render: (m) => `localização "${m[1]}" é compatível com residência no Brasil` },
  { pattern: /^location not stated$/, render: () => 'localização não informada' },
  {
    pattern: /^description mentions a location or work-authorization requirement$/,
    render: () => 'a descrição menciona exigência de localização ou de autorização de trabalho',
  },
  { pattern: /^seniority in the title: (.+)$/, render: (m) => `senioridade no título: ${m[1]}` },
];

/** A number in Brazilian style: a decimal comma ("7.8–13" becomes "7,8–13"). */
const brNumber = (text: string): string => text.replace(/\./g, ',');

export function translateReason(reason: string): string {
  for (const rule of RULES) {
    const match = rule.pattern.exec(reason);
    if (match) return rule.render(match);
  }
  return reason;
}
