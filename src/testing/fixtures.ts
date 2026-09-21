import { assembleAnalysis, parseModelOutput } from '../ai/analysis-output.js';
import { ANALYSIS_VERSION } from '../ai/current-version.js';
import type { CandidateProfile } from '../profile/candidate-profile.js';
import type { FilterResult } from '../domain/filter-result.js';
import type { MatchAnalysis } from '../domain/match-analysis.js';
import type { Opportunity } from '../domain/opportunity.js';
import { brunoCandidate } from '../profile/bruno-candidate.js';

/** Shared builders for tests. Not used by the application itself. */
export const SOURCE = 'fake';
export const NOW = new Date('2026-05-01T12:00:00.000Z');

export function makeOpportunity(id = '1', over: Partial<Opportunity> = {}): Opportunity {
  return {
    sourceId: SOURCE,
    externalId: id,
    title: `Landing page ${id}`,
    url: `https://example.test/project/${id}`,
    summary: null,
    publishedAt: `2026-04-${String(10 + (Number(id) % 15)).padStart(2, '0')}T10:00:00.000Z`,
    discoveredAt: NOW.toISOString(),
    description: 'Preciso ajustar uma landing page em HTML e CSS, com layout responsivo.',
    access: { kind: 'public', publicAt: null, rawLabel: null },
    category: 'Web, Mobile & Software',
    subcategory: 'Desenvolvimento Web',
    experienceLevel: 'Intermediário',
    skills: [],
    budget: { currency: 'BRL', kind: 'open', min: null, max: null },
    proposalCount: 1,
    interestedCount: 2,
    status: 'open',
    fetchedAt: NOW.toISOString(),
    sourceMetadata: {},
    ...over,
  };
}

export function makeFilter(decision: FilterResult['decision'] = 'shortlist'): FilterResult {
  return { decision, reasons: ['test'], matchedKeywords: ['HTML'], evaluatedAt: NOW.toISOString(), ruleVersion: 'basic-v2' };
}

/** A model answer that satisfies the schema and every local rule. */
export function validModelOutput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    score: 82,
    confidence: 'high',
    recommendation: 'apply',
    technicalFit: 'Ajuste de landing page em HTML e CSS, dentro das habilidades confirmadas.',
    essentialSkills: ['HTML', 'CSS', 'landing pages'],
    matchedSkills: ['HTML', 'CSS', 'landing pages'],
    missingSkills: [],
    risks: ['Escopo pouco detalhado'],
    clientQuestions: ['Já existe um layout pronto?'],
    effort: { minHours: 6, maxHours: 10 },
    complexity: 'low',
    price: { minBrl: 300, maxBrl: 500, rationale: 'Cerca de 8 horas a R$ 50 por hora' },
    proposalLanguage: 'pt-BR',
    proposalText:
      'Olá! Li o briefing da landing page e consigo montar em HTML e CSS com layout responsivo. ' +
      'Você já tem o layout ou parto de uma referência? Bruno',
    ...over,
  };
}

/**
 * The real profile with every unverified skill promoted to confirmed: what the candidate would look like
 * once the owner verified them. Tests that need a plain "apply" use it; the real profile is unverified.
 */
export const confirmedCandidate: CandidateProfile = {
  ...brunoCandidate,
  skills: brunoCandidate.skills.map((skill) => (skill.level === 'unverified' ? { ...skill, level: 'confirmed' as const } : skill)),
};

/** Stored under the current analysis version so batch/store tests can query it. */
export function makeAnalysis(
  opportunity: Opportunity,
  over: Record<string, unknown> = {},
  now: Date = NOW,
  candidate: CandidateProfile = confirmedCandidate,
): MatchAnalysis {
  const analysis = assembleAnalysis(parseModelOutput(JSON.stringify(validModelOutput(over))), {
    opportunity,
    candidate,
    provider: 'fake',
    model: 'fake-model',
    modelVersion: 'fake-model-001',
    now,
  });
  return { ...analysis, analysisVersion: ANALYSIS_VERSION };
}
