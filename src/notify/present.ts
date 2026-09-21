import { standingOf } from '../ai/analysis-output.js';
import type { MatchAnalysis, Recommendation, SkillVerification } from '../domain/match-analysis.js';
import type { Opportunity, OpportunityBudget } from '../domain/opportunity.js';
import type { CandidateProfile } from '../profile/candidate-profile.js';
import { aiHelpFor } from './ai-help.js';
import { restrictedAccessText } from './blocks.js';
import { excerpt } from './html.js';
import { competitionText, fitAlert, recencyLine, substantiveSummary, type AlertKind, type AlertParts, type Tier } from './layout.js';

export { COMPACT_CEILING, formatBrasiliaTime } from './layout.js';

/**
 * Portuguese Telegram presentation of a saved analysis: ONE compact message per opportunity, in the shared visual layout.
 * It is built only from what is persisted; nothing here calls an AI or adds claims. The full analysis and the proposal
 * draft stay in the database and are read with `npm run analyses`; they are never sent automatically. The effort estimate
 * and the suggested price appear only here, because only here a saved analysis exists.
 */
export type PresentMode = 'enriched' | 'update' | 'demo' | 'manual_preview';

export interface PresentInput {
  opportunity: Opportunity;
  analysis: MatchAnalysis;
  /** Used only to recognize known skill names (aliases) when showing the verification. */
  candidate?: CandidateProfile;
  mode: PresentMode;
  sourceLabels?: Readonly<Record<string, string>>;
  now: Date;
}

export interface RenderedPart {
  label: string;
  text: string;
  silent: boolean;
}

const CLASSIFICATION: Record<Recommendation, string> = {
  apply: '🟢 OPORTUNIDADE COMPATÍVEL',
  review: '🟡 VALE REVISAR',
  wait: '🕒 AGUARDAR LIBERAÇÃO',
  skip: '🔴 NÃO VALE A PENA',
};
const KIND: Record<PresentMode, AlertKind> = { enriched: 'new', update: 'update', demo: 'preview', manual_preview: 'manual_preview' };

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

export function formatBrl(min: number, max: number): string {
  return min === max ? `R$ ${number.format(min)}` : `R$ ${number.format(min)}–${number.format(max)}`;
}

export function formatHours(min: number, max: number): string {
  const unit = max === 1 ? 'hora' : 'horas';
  return min === max ? `${max} ${unit}` : `${min}–${max} ${unit}`;
}

const money = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

/**
 * An amount or range in ITS OWN currency, never converted: USD as "US$", BRL as "R$", any other by its code ("AUD").
 * One bound only reads "a partir de" or "até". Without a currency code the amounts are shown bare.
 */
export function formatMoney(currency: string, min: number | null, max: number | null): string {
  const code = currency.trim().toUpperCase();
  const symbol = code === 'USD' ? 'US$' : code === 'BRL' ? 'R$' : code;
  const amount = (value: number): string => (symbol === '' ? money.format(value) : `${symbol} ${money.format(value)}`);
  if (min !== null && max !== null) return min === max ? amount(min) : `${amount(min)}–${money.format(max)}`;
  if (min !== null) return `a partir de ${amount(min)}`;
  if (max !== null) return `até ${amount(max)}`;
  return 'não informado';
}

/** What the client informed as budget, in the original currency, kept apart from the AI's suggested price. */
export function describeClientBudget(budget: OpportunityBudget | null): string {
  if (!budget || budget.kind === 'unknown') return 'não informado';
  if (budget.min === null && budget.max === null) return budget.kind === 'open' ? 'em aberto (sem valor informado)' : 'não informado';
  const range = formatMoney(budget.currency || 'BRL', budget.min, budget.max);
  return budget.kind === 'hourly' ? `${range} por hora` : range;
}

interface VerificationView {
  verified: boolean;
  unverified: string[];
  learning: string[];
  absent: string[];
}

/**
 * Regroups the stored verification with the alias-aware matcher, so a skill that the profile knows under
 * another name (for example "design responsivo") counts as unverified rather than "absent from the profile".
 * Only the grouping for display changes; the stored analysis and its recommendation are untouched.
 */
function verificationView(verification: SkillVerification, candidate?: CandidateProfile): VerificationView {
  const view: VerificationView = {
    verified: verification.status === 'verified',
    unverified: [...verification.unverified],
    learning: [...verification.learning],
    absent: [],
  };
  for (const skill of verification.notCovered) {
    const standing = candidate ? standingOf(skill, candidate) : 'notCovered';
    if (standing === 'unverified') view.unverified.push(skill);
    else if (standing === 'learning') view.learning.push(skill);
    else if (standing === 'notCovered') view.absent.push(skill);
  }
  return view;
}

const INTERNAL_RISK = /^(Essential skills not fully verified|The model listed no essential skills|Competence not verified by the candidate|No matched skill is confirmed)/;

/** The AI's own risks, without the internal English verification note (it is derived from structured data). */
function ownRisks(analysis: MatchAnalysis): string[] {
  const seen = new Set<string>();
  return analysis.risks.filter((risk) => {
    const key = risk.trim().toLowerCase();
    if (key === '' || INTERNAL_RISK.test(risk) || risk === analysis.verification.note || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function skillList(skills: readonly string[], max: number): string {
  const shown = skills.slice(0, max).join(', ');
  const more = skills.length - max;
  return more > 0 ? `${shown} e mais ${more}` : shown;
}

/**
 * The single main caveat, in this order: restricted access (an estimate to confirm), essential skills not verified,
 * then the AI's first own risk.
 */
function mainCaveat(view: VerificationView, risks: readonly string[], access: string | null): string | null {
  if (access) return access;
  if (!view.verified) {
    const notVerified = [...view.unverified, ...view.learning];
    if (notVerified.length > 0) return `Competências essenciais ainda não verificadas: ${skillList(notVerified, 3)}.`;
    if (view.absent.length > 0) return `Ausentes no perfil: ${skillList(view.absent, 3)}.`;
    return 'A análise não listou as competências essenciais.';
  }
  return risks[0] ?? null;
}

const fitLabel = (score: number): string => (score >= 75 ? 'alta' : score >= 50 ? 'média' : 'baixa');

/**
 * Renders the ONE message of an analysis. Free-text fields are tightened tier by tier until the message fits the
 * ceiling; if even the tightest tier does not, it is an error (never a truncated tag or link).
 */
export function renderAnalysisMessage(input: PresentInput): RenderedPart {
  const { opportunity, analysis } = input;
  const view = verificationView(analysis.verification, input.candidate);
  const attention = mainCaveat(view, ownRisks(analysis), restrictedAccessText(opportunity, input.now));
  const summary = substantiveSummary((opportunity.description || opportunity.summary || '').slice(0, 4000), 260);
  const aiHelp = aiHelpFor(opportunity, analysis.recommendation !== 'skip');
  const source = input.sourceLabels?.[opportunity.sourceId] ?? opportunity.sourceId;
  const competition = competitionText(opportunity.proposalCount);

  const facts = [
    { label: '💰 Orçamento do cliente:', value: describeClientBudget(opportunity.budget) },
    { label: '💡 Preço sugerido pela IA:', value: formatBrl(analysis.price.min, analysis.price.max) },
    { label: '⏱ Esforço estimado:', value: formatHours(analysis.effort.minHours, analysis.effort.maxHours) },
    ...(competition ? [{ label: '👥 Concorrência:', value: competition }] : []),
    { label: '🎯 Compatibilidade:', value: fitLabel(analysis.score) },
  ];

  const text = fitAlert(
    (tier: Tier): AlertParts => ({
      kind: KIND[input.mode],
      classification: CLASSIFICATION[analysis.recommendation],
      title: excerpt(opportunity.title, tier.title).text,
      source,
      recency: recencyLine(opportunity, input.now),
      facts,
      project: summary === null ? null : excerpt(summary, tier.project).text,
      aiHelp: tier.aiHelp ? aiHelp : null,
      attention: attention === null ? null : excerpt(attention, tier.attention).text,
      link: opportunity.url,
      linkLabel: 'Abrir oportunidade',
    }),
  );
  return { label: 'Mensagem', text, silent: false };
}
