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
    // Categories of the Freelancer.com skill taxonomy that are not technology.
    'Writing & Content',
    'Sales & Marketing',
    'Data Entry & Admin',
    'Translation & Languages',
    'Training & Education',
    'Business, Accounting, Human Resources & Legal',
    'Product Sourcing & Manufacturing',
    'Engineering & Science',
  ],
  nonSpecificCategories: ['Outra Categoria', 'Outros', 'Other'],
  languages: ['pt', 'en'],

  // The main task of a freelance project has to be technical. Skill tags and a passing mention are not enough: these
  // words are looked for in the title and in the start of the description (see engagement-policy.ts).
  deliverableSignals: [
    { term: 'website', aliases: ['web site', 'websites', 'web sites', 'web page', 'web pages', 'webpage', 'webpages', 'landing page', 'landing pages', 'web design', 'website design', 'pagina web', 'paginas web', 'sitio web', 'sitios web'] },
    {
      term: 'site',
      aliases: ['sites'],
      except: ['on site', 'onsite', 'job site', 'job sites', 'jobsite', 'site visit', 'site visits', 'site manager', 'site supervisor', 'construction site', 'building site', 'work site', 'field site', 'site inspection'],
    },
    { term: 'web app', aliases: ['web apps', 'webapp', 'web application', 'web applications', 'web development', 'web developer', 'web platform', 'online platform'] },
    { term: 'WordPress', aliases: ['woocommerce', 'elementor', 'shopify', 'wix', 'webflow', 'squarespace', 'cms'] },
    { term: 'plugin', aliases: ['plugins', 'theme', 'themes', 'extension', 'extensions'] },
    { term: 'HTML' },
    { term: 'CSS' },
    { term: 'JavaScript', aliases: ['typescript', 'react', 'reactjs', 'node js', 'nodejs', 'vue', 'angular', 'svelte', 'next js', 'php', 'python', 'laravel', 'django'] },
    { term: 'front-end', aliases: ['frontend', 'back end', 'backend', 'full stack', 'fullstack'] },
    { term: 'API', aliases: ['apis', 'rest api', 'webhook', 'webhooks', 'integration', 'integrations', 'integracao', 'integracoes'] },
    { term: 'bot', aliases: ['bots', 'chatbot', 'chatbots', 'chat bot', 'telegram bot', 'whatsapp bot', 'discord bot'] },
    { term: 'automation', aliases: ['automations', 'automacao', 'automacoes', 'scraper', 'scrapers', 'scraping', 'script', 'scripts'] },
    { term: 'bug', aliases: ['bugs', 'bugfix', 'bug fix', 'debug', 'debugging'] },
    { term: 'software', aliases: ['application', 'applications', 'app', 'apps', 'mobile app', 'saas', 'crm', 'erp', 'dashboard', 'portal', 'database', 'sql'] },
    {
      term: 'developer',
      aliases: ['programmer', 'coding', 'development', 'desenvolvimento', 'desenvolvedor', 'sistema', 'sistemas', 'plataforma'],
      except: ['business development', 'professional development', 'personal development', 'child development', 'product development', 'community development', 'real estate development', 'staff development'],
    },
    { term: 'e-commerce', aliases: ['ecommerce', 'online store', 'loja virtual', 'checkout', 'payment gateway'] },
  ],

  offTopicTasks: [
    { term: 'payroll', aliases: ['bookkeeping', 'bookkeeper', 'accounting', 'accountant', 'tax return', 'tax returns', 'folha de pagamento', 'contabilidade', 'contador'] },
    { term: 'story', aliases: ['stories', 'story editor', 'story editing', 'storytelling', 'novel', 'manuscript', 'ghostwriting', 'ghostwriter', 'ghost writer'], except: ['user story', 'user stories'] },
    { term: 'copywriting', aliases: ['copywriter', 'copy editing', 'proofreading', 'proofreader', 'article writing', 'blog post', 'blog posts', 'content writing', 'content writer', 'essay', 'essays', 'thesis', 'redacao', 'revisao de texto'] },
    { term: 'translation', aliases: ['translator', 'transcription', 'transcriber', 'subtitling', 'voice over', 'voiceover', 'voice actor', 'traducao', 'tradutor', 'transcricao'] },
    { term: 'trading', aliases: ['trader', 'forex', 'stock market', 'day trading', 'crypto trading', 'investment advice'] },
    { term: 'virtual assistant', aliases: ['administrative assistant', 'admin assistant', 'personal assistant', 'data entry', 'lead generation', 'cold calling', 'telemarketing', 'customer support', 'customer service', 'recruiter', 'recruiting', 'resume writing', 'cv writing', 'digitacao'] },
    { term: 'sales', aliases: ['sales representative', 'sales agent', 'sales manager', 'social media management', 'social media manager', 'influencer', 'vendedor', 'vendas'] },
    { term: 'video editing', aliases: ['video editor', 'photo editing', 'photography', 'photographer', 'logo design', 'graphic design', 'illustration', 'illustrator', 'music production', 'interior design', 'edicao de video'] },
  ],

  // USD equivalents. Configurable defaults: below these the project is not worth an alert.
  budgetFloors: { fixedUsd: 50, hourlyUsd: 8 },
};
