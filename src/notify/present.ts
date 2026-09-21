import { standingOf } from '../ai/analysis-output.js';
import type { MatchAnalysis, Recommendation, SkillVerification } from '../domain/match-analysis.js';
import type { Opportunity, OpportunityBudget } from '../domain/opportunity.js';
import type { CandidateProfile } from '../profile/candidate-profile.js';
import { escapeHtml, excerpt, safeHttpUrl, visibleLength } from './html.js';

/**
 * Portuguese Telegram presentation of a saved analysis: ONE compact message per opportunity. It is built only
 * from what is persisted; nothing here calls an AI or adds claims. The full analysis and the proposal draft stay
 * in the database and are read with `npm run analyses`; they are never sent automatically.
 */
export type PresentMode = 'enriched' | 'update' | 'demo';

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

const HEADINGS: Record<Recommendation, string> = {
  apply: '🟢 VALE CANDIDATAR-SE',
  review: '🟡 VALE REVISAR',
  wait: '🕒 AGUARDAR LIBERAÇÃO',
  skip: '🔴 NÃO VALE A PENA',
};

/** The message aims at 600–900 visible characters and never exceeds the ceiling. */
export const COMPACT_CEILING = 1000;

/** Progressively tighter limits for the long free-text fields, used only when the message would not fit. */
const TIERS = [
  { title: 100, sentence: 200, caveat: 220, skills: 3, checkedAt: true },
  { title: 80, sentence: 140, caveat: 150, skills: 2, checkedAt: false },
  { title: 60, sentence: 100, caveat: 100, skills: 1, checkedAt: false },
] as const;
type Tier = (typeof TIERS)[number];

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

export function formatBrl(min: number, max: number): string {
  return min === max ? `R$ ${number.format(min)}` : `R$ ${number.format(min)}–${number.format(max)}`;
}

export function formatHours(min: number, max: number): string {
  const unit = max === 1 ? 'hora' : 'horas';
  return min === max ? `${max} ${unit}` : `${min}–${max} ${unit}`;
}

/** "21/09 às 16h37" in Brasília time; null for anything that is not a valid date. */
export function formatBrasiliaTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('day')}/${part('month')} às ${part('hour')}h${part('minute')}`;
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

/** Availability as of the last check. A release time is only ever "estimated"; nothing is stated as confirmed. */
function availability(opportunity: Opportunity, now: Date, tier: Tier): string {
  const checked = String(opportunity.sourceMetadata.accessCheckedAt ?? opportunity.fetchedAt);
  const checkedAt = formatBrasiliaTime(checked);
  const when = tier.checkedAt && checkedAt ? ` (${checkedAt})` : '';
  const { access } = opportunity;

  if (access.kind === 'public') return `aberta na última consulta${when}. Confirmar no site.`;
  if (access.kind === 'unknown') return 'não verificada. Confirmar no site.';

  const opens = access.publicAt ? formatBrasiliaTime(access.publicAt) : null;
  if (access.publicAt && opens && Date.parse(access.publicAt) <= now.getTime()) {
    return `restrita na última consulta${when}; a liberação estimada (${opens}) já passou. Confirmar no site.`;
  }
  return opens
    ? `restrita na última consulta${when}. Liberação estimada: ${opens} (Brasília); confirmar no site.`
    : `restrita na última consulta${when}; horário de liberação desconhecido. Confirmar no site.`;
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

/** The single most relevant caveat: missing verification of the essential skills first, else the AI's first risk. */
function mainCaveat(view: VerificationView, risks: readonly string[], tier: Tier): string | null {
  if (!view.verified) {
    const notVerified = [...view.unverified, ...view.learning];
    if (notVerified.length > 0) {
      return excerpt(`Competências essenciais ainda não verificadas: ${skillList(notVerified, tier.skills)}.`, tier.caveat).text;
    }
    if (view.absent.length > 0) return excerpt(`Ausentes no perfil: ${skillList(view.absent, tier.skills)}.`, tier.caveat).text;
    return 'A análise não listou as competências essenciais.';
  }
  return risks[0] ? excerpt(risks[0], tier.caveat).text : null;
}

/** Leading list numbers and heading words ("1. Objetivo") are noise in a one-sentence description. */
export function firstSentence(text: string, max: number): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^(objetivo|descrição|descricao|sobre o projeto|briefing)\s*[:–-]?\s+(?=\p{Lu})/iu, '');
  const first = /^(.+?[.!?])(?:\s|$)/u.exec(flat)?.[1] ?? flat;
  return excerpt(first, max).text;
}

function compactText(input: PresentInput, view: VerificationView, risks: readonly string[], tier: Tier): string {
  const { opportunity, analysis } = input;
  const source = input.sourceLabels?.[opportunity.sourceId] ?? opportunity.sourceId;
  const link = safeHttpUrl(opportunity.url);
  const work = firstSentence(opportunity.summary ?? opportunity.description, tier.sentence);
  const caveat = mainCaveat(view, risks, tier);

  const lines: string[] = [];
  if (input.mode === 'demo') lines.push('🧪 <b>PRÉVIA</b> · formato compacto, não é um alerta novo', '');
  lines.push(
    `<b>${HEADINGS[analysis.recommendation]}</b>${input.mode === 'update' ? ' · análise atualizada' : ''}`,
    `<b>${escapeHtml(excerpt(opportunity.title, tier.title).text)}</b>`,
    `Plataforma: ${escapeHtml(source)}`,
  );
  if (work) lines.push('', escapeHtml(work));
  lines.push(
    '',
    `Preço sugerido pela IA: ${escapeHtml(formatBrl(analysis.price.min, analysis.price.max))}`,
    `Orçamento do cliente: ${escapeHtml(describeClientBudget(opportunity.budget))}`,
    `Esforço estimado: ${escapeHtml(formatHours(analysis.effort.minHours, analysis.effort.maxHours))}`,
  );
  if (caveat) lines.push('', `⚠️ ${escapeHtml(caveat)}`);
  lines.push('', `Disponibilidade: ${escapeHtml(availability(opportunity, input.now, tier))}`);
  if (link) lines.push('', `🔗 <a href="${escapeHtml(link)}">Abrir projeto</a>`);
  return lines.join('\n');
}

/**
 * Renders the ONE message of an analysis. The free-text fields are tightened tier by tier until the message
 * fits the ceiling; if even the tightest tier does not, it is an error (never a truncated tag or link).
 */
export function renderAnalysisMessage(input: PresentInput): RenderedPart {
  const view = verificationView(input.analysis.verification, input.candidate);
  const risks = ownRisks(input.analysis);
  for (const tier of TIERS) {
    const text = compactText(input, view, risks, tier);
    if (visibleLength(text) <= COMPACT_CEILING) return { label: 'Mensagem', text, silent: false };
  }
  throw new Error(`Message exceeds ${COMPACT_CEILING} characters even in its shortest form.`);
}
