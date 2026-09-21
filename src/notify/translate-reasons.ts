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
  { pattern: /^crowded project \((\d+) proposals\): at most a review$/, render: (m) => `concorrência alta (${m[1]} propostas): no máximo revisar` },
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
  { pattern: /^fixed budget of about US\$([\d.]+) is below the US\$(\d+) floor for a shortlist$/, render: (m) => `orçamento fixo de cerca de US$${m[1]} abaixo do mínimo de US$${m[2]} para shortlist` },
  { pattern: /^hourly rate of about US\$([\d.]+)\/h is below the US\$(\d+)\/h floor for a shortlist$/, render: (m) => `valor por hora de cerca de US$${m[1]}/h abaixo do mínimo de US$${m[2]}/h para shortlist` },
  {
    pattern: /^(fixed|hourly) budget range of about US\$(.+?)(\/h)? crosses the US\$(\d+)(\/h)? floor: at most a review$/,
    render: (m) => `faixa de orçamento (cerca de US$${m[2]}${m[3] ?? ''}) atravessa o mínimo de US$${m[4]}${m[5] ?? ''}: no máximo revisar`,
  },
  { pattern: /^budget currency "(.+)" has no reliable USD conversion$/, render: (m) => `moeda do orçamento (${m[1]}) sem conversão confiável para dólar` },
  { pattern: /^budget currency not stated: no reliable USD conversion$/, render: () => 'moeda do orçamento não informada' },
  { pattern: /^very crowded project \((\d+) proposals\): at most a review, lowest priority$/, render: (m) => `concorrência muito alta (${m[1]} propostas): no máximo revisar, prioridade mínima` },
  { pattern: /^very short deadline \(about (\d+) hours\): at most a review$/, render: (m) => `prazo muito curto (cerca de ${m[1]} horas): no máximo revisar` },
  { pattern: /^transactional scope \(payments or checkout\): at most a review$/, render: () => 'escopo transacional (pagamentos ou checkout): no máximo revisar' },
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

export function translateReason(reason: string): string {
  for (const rule of RULES) {
    const match = rule.pattern.exec(reason);
    if (match) return rule.render(match);
  }
  return reason;
}
