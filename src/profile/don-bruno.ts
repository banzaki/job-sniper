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
    { term: 'virtual assistant', aliases: ['chat support', 'chat agent', 'chat operator', 'live chat', 'customer care', 'support agent', 'call center', 'administrative assistant', 'admin assistant', 'personal assistant', 'data entry', 'lead generation', 'cold calling', 'telemarketing', 'customer support', 'customer service', 'recruiter', 'recruiting', 'resume writing', 'cv writing', 'digitacao'] },
    { term: 'sales', aliases: ['sales representative', 'sales agent', 'sales manager', 'social media management', 'social media manager', 'influencer', 'vendedor', 'vendas'] },
    { term: 'video editing', aliases: ['video editor', 'photo editing', 'photography', 'photographer', 'logo design', 'graphic design', 'illustration', 'illustrator', 'music production', 'interior design', 'edicao de video'] },
  ],

  // USD equivalents. Configurable defaults: a budget whose bottom reaches its floor is needed for a TOP MATCH. A lower
  // budget never removes an opportunity and does not cap it: it is a caveat that lowers the ranking.
  budgetFloors: { fixedUsd: 50, hourlyUsd: 8 },

  // Advanced only when the MAIN delivery is transactional. A shop that just mentions PayPal is an ordinary shop.
  transactionalScope: {
    titleTerms: [
      { term: 'payment', aliases: ['payments', 'payment gateway', 'payment gateways', 'checkout', 'billing', 'subscription', 'subscriptions', 'ticketing', 'ticket booking', 'booking system', 'reservation system', 'stripe', 'paypal', 'wallet', 'invoicing', 'pagamento', 'pagamentos', 'cobranca', 'assinatura', 'assinaturas'] },
    ],
    central: [
      { term: 'recurring billing', aliases: ['recurring payments', 'subscription billing', 'subscription payments', 'subscription management', 'multiple payment gateways', 'multi gateway', 'payment processing', 'custom checkout', 'checkout flow', 'ticketing', 'booking engine', 'booking system', 'reservation system', 'financial transactions', 'payouts', 'escrow', 'split payments', 'cobranca recorrente'] },
    ],
    objects: [{ term: 'payment', aliases: ['payments', 'payment gateway', 'payment gateways', 'billing', 'subscription', 'subscriptions', 'pagamento', 'pagamentos'] }],
    actions: ['implement', 'integrat', 'fix', 'debug', 'repair', 'troubleshoot', 'custom', 'build', 'develop', 'creat', 'set up', 'setup', 'configur', 'add', 'implementar', 'integrar', 'corrigir', 'criar', 'desenvolver'],
  },

  // Skills the profile does not offer. Central to the work (title, or the start of the description with no available skill
  // named) it is a skip; beside an available skill it is a doubt.
  unavailableSkills: [
    { term: 'python', aliases: ['django', 'flask', 'fastapi', 'pandas'] },
    { term: 'rust' },
    { term: 'golang' },
    { term: 'java', aliases: ['spring boot'] },
    { term: 'c sharp', aliases: ['csharp', 'dotnet', 'asp net', 'vb net'] },
    { term: 'ruby', aliases: ['ruby on rails', 'rails'] },
    { term: 'mobile app', aliases: ['mobile apps', 'mobile application', 'mobile applications', 'android app', 'android apps', 'ios app', 'ios apps', 'iphone app', 'cross platform app', 'aplicativo mobile', 'aplicativo para celular', 'flutter', 'react native', 'kotlin', 'swiftui', 'android nativo', 'ios nativo', 'app nativo', 'aplicativo nativo'] },
    { term: 'game development', aliases: ['game developer', 'unity', 'unreal engine', 'godot'] },
    { term: 'machine learning', aliases: ['deep learning', 'data science', 'data scientist', 'computer vision', 'neural network'] },
    { term: 'devops', aliases: ['kubernetes', 'k8s', 'terraform', 'ci cd', 'docker swarm'] },
    { term: 'blockchain', aliases: ['web3', 'smart contract', 'smart contracts', 'solidity', 'nft'] },
    { term: 'embedded systems', aliases: ['firmware', 'arduino', 'raspberry pi', 'microcontroller'] },
    { term: 'voip', aliases: ['pabx', 'asterisk', 'telefonia'] },
    // Site platforms are judged by the skills configured here, not by a global block: add a platform to `strongSignals` and it
    // stops being outside the profile (an unavailable term that is also a configured skill is ignored).
    { term: 'shopify' },
    { term: 'webflow' },
    { term: 'wix' },
    { term: 'squarespace' },
    { term: 'magento', aliases: ['prestashop', 'opencart'] },
  ],

  offTopicUnlessStrong: [
    { term: 'meta ads', aliases: ['facebook ads', 'instagram ads', 'google ads', 'tiktok ads', 'social media ads', 'ads campaign', 'ad campaigns', 'ad account', 'ad accounts', 'paid acquisition', 'paid social', 'ppc', 'media buying', 'seo', 'search engine optimization'] },
  ],

  // Words that alone do not prove fit: a green needs a specific skill (the other terms) in the title or the start of the description.
  genericSignalTerms: ['responsividade', 'front-end', 'site', 'web', 'sistema', 'desenvolvimento web'],

  // Back-end work: the profile offers front-end, simple WordPress sites, simple APIs and small automations only.
  backendWork: {
    strong: [
      { term: 'back end', aliases: ['backend', 'back-end', 'full stack', 'fullstack', 'server side'] },
      { term: 'laravel', aliases: ['symfony', 'codeigniter', 'cakephp', 'yii', 'filament', 'spring boot', 'nestjs', 'nest js'] },
      { term: 'node js', aliases: ['nodejs', 'express js', 'expressjs'] },
      { term: 'scraping', aliases: ['scraper', 'scrapers', 'web scraping', 'crawler', 'headless browser', 'headless', 'puppeteer', 'playwright', 'selenium'] },
      { term: 'websocket', aliases: ['websockets', 'real time data', 'live data feed'] },
      { term: 'multi tenant', aliases: ['multitenant', 'saas', 'microservices', 'microsservicos'] },
    ],
    weak: [
      { term: 'database', aliases: ['databases', 'database design', 'sql', 'mysql', 'postgres', 'mongodb', 'banco de dados'] },
      { term: 'authentication', aliases: ['sign up', 'signup', 'log in', 'login', 'user accounts', 'user profiles', 'autenticacao', 'cadastro de usuarios', 'login de usuarios'] },
      { term: 'file uploads', aliases: ['upload photos', 'upload files', 'admin panel', 'painel administrativo', 'role based'] },
    ],
  },

  largeScopeSignals: [
    { term: 'enterprise', aliases: ['marketplace', 'saas', 'erp', 'crm', 'multi vendor', 'multi tenant', 'microservices', 'social network', 'learning management system', 'lms'] },
  ],
};
