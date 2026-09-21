import type { FilterDecision } from '../domain/filter-result.js';
import type { Opportunity } from '../domain/opportunity.js';
import { normalizeText } from '../text.js';

const CONTROL = ' Você ainda controla briefing, decisões e entrega.';

/**
 * Deterministic "how AI can help" sentences, chosen from the signals written in the title and description themselves
 * (skill tags are ignored: they are often generic), and only from the central task: the title, then the start of the description. No AI is called. The sentences describe what AI can speed up in that
 * kind of work; they never say the person masters the skill. Order matters, the kind that changes the work most first:
 * a bug or error to fix (diagnosis, not building), then an API or integration, then WordPress, then front-end work
 * (named technologies), then automation, and last a plainly stated request to build a site or app. With no clear
 * signal there is no sentence, and the block is omitted.
 */
const KINDS: { pattern: RegExp; text: string }[] = [
  {
    pattern: /\b(bugs?|debug\w*|fix|fixes|corrig\w*|correc\w*|conserto|consertar|errors?(?! handling)|erros?)\b/,
    text: 'Ajudar a organizar o diagnóstico, levantar hipóteses e montar um checklist de validação. Você executa e confirma cada correção.',
  },
  {
    pattern: /\b(apis?|integra\w*|integrations?|webhooks?)\b/,
    text: `Ajudar a esboçar as chamadas, o tratamento de erros e os testes básicos da integração.${CONTROL}`,
  },
  {
    pattern: /\b(wordpress|woocommerce|elementor)\b/,
    text: `Acelerar a montagem das seções, o ajuste do tema e a revisão do conteúdo.${CONTROL}`,
  },
  {
    pattern: /\b(html|css|javascript|typescript|react|front ?end|landing pages?|responsiv\w*)\b/,
    text: `Acelerar a estrutura inicial, os componentes e a revisão responsiva.${CONTROL}`,
  },
  {
    pattern: /\b(bots?|chatbots?|telegram|whatsapp|automa\w*|automation|automat\w*|scraping)\b/,
    text: `Ajudar a desenhar o fluxo, escrever o script inicial e testar os casos comuns.${CONTROL}`,
  },
  {
    pattern: /\b(build|create|develop|criar|criacao|desenvolv\w*|construir)\b.{0,40}\b(websites?|web sites?|sites?|web ?apps?|sistemas?)\b/,
    text: `Acelerar a estrutura inicial, os componentes e a revisão responsiva.${CONTROL}`,
  },
];

/** How much of the description counts as the start, where the central task is stated (about the first 60 words). */
const CENTRAL_TASK_LENGTH = 400;

/**
 * A sentence for the CENTRAL task, or null: with no clear signal the block is omitted. The kind is chosen from the title, and only
 * when the title names none from the start of the description. A word such as "integration", "error" or "fix" further into the
 * text is about something else than the task and never decides it.
 */
export function aiHelpFor(opportunity: Pick<Opportunity, 'title' | 'description'>, safe: boolean): string | null {
  if (!safe) return null;
  const title = normalizeText(opportunity.title);
  const fromTitle = KINDS.find((kind) => kind.pattern.test(title));
  if (fromTitle) return fromTitle.text;
  const start = normalizeText(opportunity.description.slice(0, CENTRAL_TASK_LENGTH));
  return KINDS.find((kind) => kind.pattern.test(start))?.text ?? null;
}

/** Only work with no advanced scope, and whose skills are really named in the text, is safe to describe. */
export function isSafeForAiHelp(decision: FilterDecision, reasons: readonly string[]): boolean {
  return decision !== 'skip' && !reasons.some((reason) => reason.startsWith('conflicting or advanced scope') || reason.startsWith('strong skills appear only as tags') || reason.startsWith('title names non-technical') || reason.startsWith('technical deliverable is not clear') || reason.startsWith('essential skill outside the profile') || reason.startsWith('back-end work beside') || reason.startsWith('no specific technical skill') || /^category ".*" is not technology, but/.test(reason) || reason.startsWith('project language uncertain'));
}
