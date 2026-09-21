import type { InterestProfile } from './interest-profile.js';

/**
 * Matching is case- and accent-insensitive and respects word boundaries, so aliases only
 * need distinct spellings ("front-end" and "front end" are the same after normalization).
 * Changing anything here changes filter results: bump FILTER_RULE_VERSION when you do.
 */
export const donBrunoProfile: InterestProfile = {
  name: 'Don Bruno',

  strongSignals: [
    { term: 'HTML' },
    { term: 'CSS' },
    { term: 'JavaScript', aliases: ['java script'] },
    { term: 'TypeScript' },
    { term: 'landing page', aliases: ['landing pages', 'landingpage'] },
    { term: 'front-end', aliases: ['frontend'] },
    { term: 'responsividade', aliases: ['responsivo', 'responsiva', 'responsive', 'layout responsivo'] },
    { term: 'WordPress' },
    {
      term: 'correção de bug front-end',
      aliases: [
        'bug front end',
        'bugs front end',
        'bug no front end',
        'bugs no front end',
        'correcao de bug no site',
        'correcao de bugs no site',
        'corrigir bug no site',
        'corrigir bugs no site',
      ],
    },
    // "React Native" is mobile, not web: matches inside it do not count.
    { term: 'React', aliases: ['reactjs', 'react js'], except: ['react native'] },
    { term: 'site simples', aliases: ['sites simples', 'site institucional', 'sites institucionais'] },
    { term: 'página institucional', aliases: ['paginas institucionais'] },
  ],

  weakSignals: [
    { term: 'API', aliases: ['apis'] },
    { term: 'integração', aliases: ['integracoes', 'pequenas integracoes'] },
    { term: 'automação', aliases: ['automacoes', 'automatizar', 'automatizacao', 'automation'] },
    { term: 'bot', aliases: ['bots', 'chatbot', 'chat bot'] },
    { term: 'Telegram' },
    { term: 'sistema', aliases: ['sistemas'] },
    { term: 'site', aliases: ['sites', 'website', 'web site', 'criacao de site', 'desenvolvimento de site'] },
    { term: 'web' },
    { term: 'desenvolvimento web' },
    { term: 'bug', aliases: ['bugs', 'bugfix', 'bug fix', 'correcao de bugs'] },
  ],

  conflictSignals: [
    { term: 'IA privada', aliases: ['ia local', 'ia self hosted'] },
    { term: 'LLM', aliases: ['llms', 'modelo de linguagem', 'modelos de linguagem'] },
    { term: 'self-hosted', aliases: ['self hosted', 'servidor proprio'] },
    { term: 'infraestrutura', aliases: ['infraestruturas'] },
    { term: 'Kubernetes', aliases: ['k8s'] },
    { term: 'DevOps' },
    { term: 'arquitetura corporativa', aliases: ['arquitetura empresarial'] },
    {
      term: 'desenvolvimento mobile nativo',
      aliases: ['mobile nativo', 'app nativo', 'aplicativo nativo', 'android nativo', 'ios nativo', 'kotlin', 'swiftui'],
    },
    { term: 'React Native', aliases: ['flutter'] },
    { term: 'blockchain', aliases: ['web3', 'smart contract', 'smart contracts'] },
    { term: 'telefonia', aliases: ['voip', 'pabx', 'asterisk'] },
    { term: 'agente de voz', aliases: ['agentes de voz', 'voice agent', 'ia de voz'] },
  ],

  directCategories: ['Desenvolvimento Web', 'Desenvolvimento Front-end', 'Integrações e Automações'],
  broadCategories: ['Web, Mobile & Software'],
  excludedCategories: [
    'Administração & Contabilidade',
    'Advogados & Leis',
    'Atendimento ao Consumidor',
    'Design & Criação',
    'Educação & Consultoria',
    'Escrita',
    'Fotografia & AudioVisual',
    'Suporte Administrativo',
    'Tradução',
    'Vendas & Marketing',
    // Categories of the Remotive job feed that are not programming (its API did not restrict by category).
    'Writing',
    'Design',
    'Marketing',
    'Sales',
    'Sales / Business',
    'Business',
    'Customer Service',
    'Human Resources',
    'Finance / Legal',
  ],
  nonSpecificCategories: ['Outra Categoria', 'Outros', 'Other'],
};
