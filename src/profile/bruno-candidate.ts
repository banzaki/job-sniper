import type { CandidateProfile, CandidateSkill } from './candidate-profile.js';

const INTEREST_ONLY =
  'Listed as an interest in the approved interest profile (SPEC 002). Competence not verified by the owner.';

/** An interest whose competence nobody has verified yet. Change to "confirmed" only on the owner's word. */
const unverified = (name: string, note?: string): CandidateSkill => ({
  name,
  level: 'unverified',
  interest: true,
  evidence: INTEREST_ONLY,
  ...(note ? { note } : {}),
});

/**
 * PROVISIONAL profile. Nothing here is a verified competence: the skills below come from the interest
 * list, and interest is not competence. Don Bruno must review this file and promote a skill to
 * "confirmed" himself; until then no analysis recommends "apply" and no proposal may assert competence.
 * Any relevant change to this file changes the analysis version, so stored analyses are redone.
 */
export const brunoCandidate: CandidateProfile = {
  displayName: 'Bruno',
  // Declared by Don Bruno himself. Individual competences are not inferred from any of this.
  declaredContext: [
    'Beginner in programming, working with guidance and AI assistance.',
    'Took part in the practical configuration and validation of the Job Sniper project.',
    'Has not yet built and published a complete landing page.',
    'Individual technical competences are not confirmed by inference.',
  ],
  skills: [
    unverified('HTML'),
    unverified('CSS'),
    unverified('JavaScript'),
    unverified('TypeScript'),
    unverified('responsive layouts'),
    unverified('landing pages', 'small scope'),
    unverified('front-end bug fixing'),
    unverified('WordPress', 'simple sites only'),
    unverified('simple APIs', 'small integrations'),
    unverified('Telegram bots'),
    unverified('small automations'),
    { name: 'React', level: 'learning', interest: true, evidence: INTEREST_ONLY, note: 'basic level only' },

    {
      name: 'native mobile development',
      level: 'unavailable',
      aliases: ['android nativo', 'ios nativo', 'mobile nativo', 'aplicativo nativo', 'app nativo', 'swift', 'kotlin', 'flutter'],
    },
    { name: 'React Native', level: 'unavailable' },
    {
      name: 'private or self-hosted AI/LLM infrastructure',
      level: 'unavailable',
      aliases: ['ia privada', 'llm', 'self hosted', 'modelo local', 'servidor de ia'],
    },
    { name: 'DevOps', level: 'unavailable', aliases: ['ci cd', 'docker swarm', 'terraform'] },
    { name: 'Kubernetes', level: 'unavailable', aliases: ['k8s'] },
    { name: 'blockchain', level: 'unavailable', aliases: ['web3', 'smart contract', 'smart contracts'] },
    { name: 'telephony', level: 'unavailable', aliases: ['telefonia', 'voip', 'pabx', 'asterisk'] },
    { name: 'complex voice agents', level: 'unavailable', aliases: ['agente de voz', 'agentes de voz', 'voice agent'] },
    { name: 'enterprise architecture', level: 'unavailable', aliases: ['arquitetura corporativa', 'arquitetura empresarial'] },
  ],
  // No employers, clients, projects, years of experience or certifications are recorded.
  recordedExperience: [],
  sourceCapabilities: {
    '99freelas': { accountTier: 'free', canApplyToPremiumOnly: false },
  },
};
