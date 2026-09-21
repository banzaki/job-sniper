import type { FilterResult } from '../domain/filter-result.js';
import type { EmploymentType, Opportunity } from '../domain/opportunity.js';
import { isSafeForAiHelp, aiHelpFor } from './ai-help.js';
import { basicAttention, CLASSIFICATION, compatibilityLabel, relevantSkills } from './blocks.js';
import { fitAlert, competitionText, recencyLine, substantiveSummary, type AlertKind, type AlertParts, type Tier } from './layout.js';
import { excerpt } from './html.js';
import type { ExchangeRateLookup } from '../storage/exchange-rate-store.js';
import { displayBudget, type BudgetDisplayOptions } from './budget-display.js';

export { escapeHtml } from './html.js';
export { recencyLine } from './layout.js';

export const TEST_MESSAGE = '🎯 Job Sniper online.';

const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  freelance: 'Freelance',
  contract: 'Contrato',
  full_time: 'Tempo integral',
  part_time: 'Meio período',
  internship: 'Estágio',
  other: 'Outro',
  unknown: 'não informado',
};

export interface FormatOptions {
  /** Display names by sourceId; unknown ids are shown as they are. */
  sourceLabels?: Readonly<Record<string, string>>;
  /** Why the message exists: a real new opportunity (the default), a manual format preview, or an updated analysis. */
  kind?: AlertKind;
  /** The moment used to say how long ago something was published. Defaults to the current time. */
  now?: Date;
  /** The currency the budget is shown in first when a fresh stored rate allows it (default USD). The original is shown below. */
  displayCurrency?: string;
  /** The rates a source published, kept in the database (the delivery fills it in). Without them only the original is shown. */
  rates?: ExchangeRateLookup;
}

/** Only this much of a description is ever read to build the summary. */
const SUMMARY_SOURCE_LENGTH = 4000;

/**
 * The compact pt-BR alert of an opportunity that has no AI analysis (the basic filter's notification), in the shared
 * visual layout: header, classification, title and source, facts, the work, how AI can help, the main caveat and the link.
 * Three kinds of source differ only in their facts: a projects marketplace or 99Freelas (budget, competition, type), and
 * a jobs source such as Remotive (pay as published, type, required location). No score, suggested price, effort or
 * proposal appears: none was produced.
 */
export function formatOpportunityMessage(opportunity: Opportunity, filter: FilterResult, options: FormatOptions = {}): string {
  const now = options.now ?? new Date();
  const source = options.sourceLabels?.[opportunity.sourceId] ?? opportunity.sourceId;
  const isJob = opportunity.employmentType !== undefined && opportunity.locationRequirement !== undefined;
  const facts = isJob ? jobFacts(opportunity, filter) : projectFacts(opportunity, filter, { now, ...(options.displayCurrency ? { displayCurrency: options.displayCurrency } : {}), ...(options.rates ? { rates: options.rates } : {}) });
  const summary = substantiveSummary((opportunity.description || opportunity.summary || '').slice(0, SUMMARY_SOURCE_LENGTH), 260);
  const attention = basicAttention(opportunity, filter, now);
  const aiHelp = aiHelpFor(opportunity, isSafeForAiHelp(filter.decision, filter.reasons));

  return fitAlert((tier: Tier): AlertParts => ({
    kind: options.kind ?? 'new',
    classification: CLASSIFICATION[filter.decision],
    title: excerptTitle(opportunity.title, tier.title),
    source,
    recency: recencyLine(opportunity, now),
    facts,
    project: summary === null ? null : cut(summary, tier.project),
    aiHelp: tier.aiHelp ? aiHelp : null,
    attention: attention === null ? null : cut(attention, tier.attention),
    link: opportunity.url,
    linkLabel: 'Abrir oportunidade',
  }));
}

/** 99Freelas and a projects marketplace: the client's budget in its own currency, competition, type and skills. */
function projectFacts(opportunity: Opportunity, filter: FilterResult, display: BudgetDisplayOptions): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  const budget = opportunity.budget;
  // The preferred currency first (with "≈") when a fresh stored rate allows it, the original below; hourly keeps its "/h".
  const shown = displayBudget(opportunity, display);
  facts.push({ label: '💰 Orçamento:', value: shown.value });
  if (shown.original !== null) facts.push({ label: '↳ Original:', value: shown.original });
  const competition = competitionText(opportunity.proposalCount);
  if (competition) facts.push({ label: '👥 Concorrência:', value: competition });
  if (budget?.kind === 'fixed') facts.push({ label: '🧰 Tipo:', value: 'preço fixo' });
  if (budget?.kind === 'hourly') facts.push({ label: '🧰 Tipo:', value: 'por hora' });
  const skills = relevantSkills(filter);
  if (skills.length > 0) facts.push({ label: '🧩 Habilidades:', value: skills.join(', ') });
  facts.push({ label: '🎯 Compatibilidade:', value: compatibilityLabel(filter) });
  return facts;
}

/** A jobs source: the pay exactly as published (never converted, never a budget), the type and the required location. */
function jobFacts(opportunity: Opportunity, filter: FilterResult): { label: string; value: string }[] {
  const type = opportunity.employmentType ?? 'unknown';
  const typeLabel = type === 'other' && typeof opportunity.sourceMetadata.jobTypeRaw === 'string' ? opportunity.sourceMetadata.jobTypeRaw : EMPLOYMENT_LABEL[type];
  const facts = [
    { label: '💰 Remuneração (como publicada):', value: opportunity.compensation ? cut(opportunity.compensation, 80) : 'não informada' },
    { label: '🧰 Tipo:', value: typeLabel },
    { label: '📍 Localização exigida:', value: opportunity.locationRequirement ? cut(opportunity.locationRequirement, 80) : 'não informada' },
  ];
  const skills = relevantSkills(filter);
  if (skills.length > 0) facts.push({ label: '🧩 Habilidades:', value: skills.join(', ') });
  facts.push({ label: '🎯 Compatibilidade:', value: compatibilityLabel(filter) });
  return facts;
}

const cut = (text: string, max: number): string => excerpt(text, max).text;
const excerptTitle = (title: string, max: number): string => excerpt(title, max).text;
