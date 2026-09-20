import type { InterestProfile } from './interest-profile.js';

/**
 * Matching is case- and accent-insensitive and respects word boundaries, so aliases only
 * need distinct spellings ("front-end" and "front end" are the same after normalization).
 * Broad words such as "site" or "integração" are deliberately not used alone.
 */
export const donBrunoProfile: InterestProfile = {
  name: 'Don Bruno',
  keywords: [
    { term: 'HTML' },
    { term: 'CSS' },
    { term: 'JavaScript', aliases: ['java script'] },
    { term: 'TypeScript' },
    { term: 'React', aliases: ['reactjs', 'react js'] },
    { term: 'front-end', aliases: ['frontend'] },
    { term: 'landing page', aliases: ['landing pages', 'landingpage'] },
    { term: 'responsividade', aliases: ['responsivo', 'responsiva', 'responsive', 'layout responsivo'] },
    { term: 'WordPress' },
    {
      term: 'correção de bugs',
      aliases: ['correcao de bug', 'corrigir bug', 'corrigir bugs', 'bug fix', 'bugfix', 'bug', 'bugs'],
    },
    { term: 'API', aliases: ['apis'] },
    { term: 'bot', aliases: ['bots', 'chatbot', 'chat bot'] },
    { term: 'Telegram' },
    { term: 'automação', aliases: ['automacoes', 'automatizar', 'automatizacao', 'automation'] },
    {
      term: 'pequenas integrações',
      aliases: ['pequena integracao', 'integracao com api', 'integracoes com api', 'integracao de api'],
    },
    {
      term: 'desenvolvimento web',
      aliases: [
        'desenvolvimento de site',
        'desenvolvimento de sites',
        'criacao de site',
        'criacao de sites',
        'website',
        'web site',
        'site institucional',
      ],
    },
  ],
  relevantCategories: [
    'Web, Mobile & Software',
    'Desenvolvimento Web',
    'Desenvolvimento Front-end',
    'Integrações e Automações',
  ],
  nonSpecificCategories: ['Outra Categoria', 'Outros', 'Other'],
};
