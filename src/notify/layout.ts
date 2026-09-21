import type { Opportunity } from '../domain/opportunity.js';
import { escapeHtml, excerpt, safeHttpUrl, visibleLength } from './html.js';

/** The message aims at a few hundred visible characters and never exceeds this ceiling. */
export const COMPACT_CEILING = 1000;

/** Why the message exists: a real new opportunity, a manual format preview, or the update of an older analysis. */
export type AlertKind = 'new' | 'preview' | 'update';

const KIND_HEADER: Record<AlertKind, string> = {
  new: '🚨 NOVA OPORTUNIDADE',
  preview: '🧪 PRÉVIA DE FORMATO',
  update: '🔄 ANÁLISE ATUALIZADA',
};

export interface AlertParts {
  kind: AlertKind;
  /** For example "🟢 BOA OPORTUNIDADE". A fixed label, never external text. */
  classification: string;
  title: string;
  source: string;
  /** "🆕 Publicada hoje" or null. */
  recency: string | null;
  /** Fact lines, each with its own emoji; the text after the label is external and is escaped here. */
  facts: { label: string; value: string }[];
  /** The work, in at most two short sentences. */
  project: string | null;
  /** Deterministic sentence about how AI can speed the work up, or null. */
  aiHelp: string | null;
  /** The single main caveat, or null. */
  attention: string | null;
  link: string | null;
  linkLabel: string;
}

/** Blocks separated by a blank line: header, classification, title, facts, project, AI help, attention, link. */
export function assembleAlert(parts: AlertParts): string {
  const blocks: string[] = [
    `<b>${KIND_HEADER[parts.kind]}</b>`,
    `<b>${parts.classification}</b>`,
    [`<b>${escapeHtml(parts.title)}</b>`, `🌐 ${escapeHtml(parts.source)}${parts.recency ? ` · ${parts.recency}` : ''}`].join('\n'),
  ];
  if (parts.facts.length > 0) blocks.push(parts.facts.map((fact) => `${fact.label} ${escapeHtml(fact.value)}`).join('\n'));
  if (parts.project) blocks.push(`<b>📝 O projeto</b>\n${escapeHtml(parts.project)}`);
  if (parts.aiHelp) blocks.push(`<b>🤖 Como a IA pode ajudar</b>\n${escapeHtml(parts.aiHelp)}`);
  if (parts.attention) blocks.push(`<b>⚠️ Atenção</b>\n${escapeHtml(parts.attention)}`);
  const link = parts.link ? safeHttpUrl(parts.link) : null;
  if (link) blocks.push(`🔗 <a href="${escapeHtml(link)}">${escapeHtml(parts.linkLabel)}</a>`);
  return blocks.join('\n\n');
}

/** Progressively tighter limits; the last step also drops the AI-help block, which is optional. */
export const TIERS = [
  { title: 100, project: 260, attention: 200, aiHelp: true },
  { title: 80, project: 180, attention: 140, aiHelp: true },
  { title: 60, project: 120, attention: 100, aiHelp: false },
] as const;
export type Tier = (typeof TIERS)[number];

/** Builds the message with the loosest tier that fits the ceiling; an error if not even the tightest one does. */
export function fitAlert(build: (tier: Tier) => AlertParts): string {
  for (const tier of TIERS) {
    const text = assembleAlert(build(tier));
    if (visibleLength(text) <= COMPACT_CEILING) return text;
  }
  throw new Error(`Message exceeds ${COMPACT_CEILING} characters even in its shortest form.`);
}

// ---------- the summary of the work ----------
const MIN_SENTENCE_LENGTH = 30;
const MIN_WORDS = 4;

/** Opening pleasantries, alone or before the real text ("Hi there, I need a landing page"). */
const GREETING =
  /^(?:hello|hi|hey|greetings|dear\s+\p{L}+|good\s+(?:morning|afternoon|evening)|ol[áa]|oi|bom\s+dia|boa\s+(?:tarde|noite)|prezad[oa]s?(?:\s+\p{L}+)?|car[oa]s?\s+(?:freelancers?|profissionais|desenvolvedores?))(?:\s+(?:there|everyone|all|team|guys|sir|madam|freelancers?|developers?|pessoal|amigos?|galera))?\s*[,!.:;–-]*\s*/iu;
/** A section label in front of the text: "Description:", "Project description -", "Objective:". */
const LABEL =
  /^(?:descri[çc][ãa]o(?:\s+do\s+projeto)?|project\s+description|job\s+description|description|objective|objetivo|sobre\s+o\s+projeto|about\s+the\s+project|overview|summary|briefing|scope|escopo)\s*[:–-]\s*/iu;
/** Lines that say nothing about the work. */
const FILLER =
  /\b(?:hope\s+(?:this|you)|thanks?\s+(?:you\s+)?for\s+(?:reading|your\s+time|looking)|obrigad[oa]\s+pel[ao]|please\s+read|read\s+(?:the\s+)?(?:description|carefully)|only\s+serious|no\s+time\s+wasters|leia\s+com\s+aten)/iu;
/** A short generic heading that survived as its own line ("Project Description", "Requirements"). */
const GENERIC_HEADING =
  /^(?:project|job|description|requirements?|about(?:\s+us)?|overview|summary|details|introduction|scope|objective|skills|deliverables?|budget|timeline|requisitos?|detalhes|descri[çc][ãa]o|objetivo|escopo)(?:\s+\p{L}+){0,2}\s*:?$/iu;

/** "Objetivo Vender o produto...": the bare word in front of a capital letter is a label too (no colon). */
const LABEL_BARE = /^(?:[Oo]bjetivo|[Oo]bjective|OBJETIVO|OBJECTIVE)\s+(?=\p{Lu})/u;

/** Removes the leading numbering, greetings and section labels, in whatever order they come. */
function stripOpening(unit: string): string {
  let text = unit.trim();
  for (let round = 0; round < 4; round += 1) {
    const before = text;
    text = text.replace(/^\s*(?:\d+[.)]|[-–•*])\s*/u, '').replace(LABEL, '').replace(LABEL_BARE, '').replace(GREETING, '').trim();
    if (text === before) break;
  }
  return text;
}

function isSubstantive(unit: string): boolean {
  if (unit.length < MIN_SENTENCE_LENGTH) return false;
  if (unit.split(/\s+/).length < MIN_WORDS) return false;
  if (unit.endsWith(':')) return false;
  if (GENERIC_HEADING.test(unit) || FILLER.test(unit)) return false;
  return /\p{L}{3,}/u.test(unit);
}

/**
 * The first substantive stretch of a description, up to two short sentences, or null when nothing useful exists (the
 * caller then omits the block). Greetings, numbering, section labels, very short lines, generic headings and pleasantries
 * are skipped; the text that remains is the author's own, never rewritten or completed.
 */
export function substantiveSummary(text: string, max: number): string | null {
  const units: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    for (const piece of line.split(/(?<=[.!?])\s+/u)) {
      const unit = stripOpening(piece.replace(/\s+/g, ' '));
      if (isSubstantive(unit)) units.push(unit);
    }
  }
  const first = units[0];
  if (!first) return null;
  const second = units[1];
  const joined = second ? `${first} ${second}` : first;
  return excerpt(joined.length <= max ? joined : first, max).text;
}
// ---------- recency ----------
const DAY_MS = 86_400_000;
const brasiliaDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
/** YYYY-MM-DD of an instant in Brasília time. */
const brasiliaDay = (ms: number): string => brasiliaDate.format(new Date(ms));
/** Age is highlighted only for a publication this recent; older or unknown dates get no highlight. */
const RECENT_DAYS = 7;

/**
 * "🆕 Publicada hoje / há X dias" for a reliable publication date up to 7 days old; null otherwise. A real instant is
 * compared by calendar day in Brasília time (the reader's day). A date that came without a time zone only gives its
 * calendar day, compared with today's date; no time of day is ever shown or assumed. A future or missing date says nothing.
 */
export function recencyLine(opportunity: Opportunity, now: Date): string | null {
  let days: number | null = null;
  const instant = opportunity.publishedAt ? Date.parse(opportunity.publishedAt) : Number.NaN;
  // Rows stored before publishedDay existed still carry the raw text, flagged as having no time zone.
  const meta = opportunity.sourceMetadata;
  const day = meta.publishedDay ?? (meta.publishedTimezone === 'not stated' && typeof meta.publishedRaw === 'string' ? meta.publishedRaw.slice(0, 10) : null);
  if (!Number.isNaN(instant)) {
    days = Math.round((Date.parse(`${brasiliaDay(now.getTime())}T00:00:00Z`) - Date.parse(`${brasiliaDay(instant)}T00:00:00Z`)) / DAY_MS);
  } else if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    days = Math.round((Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);
  }
  if (days === null || days < 0 || days > RECENT_DAYS) return null;
  return days === 0 ? '🆕 Publicada hoje' : `🆕 Publicada há ${days} ${days === 1 ? 'dia' : 'dias'}`;
}

// ---------- competition ----------
export function competitionText(proposals: number | null): string | null {
  if (proposals === null) return null;
  return `${proposals} ${proposals === 1 ? 'proposta' : 'propostas'}`;
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
