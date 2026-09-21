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
