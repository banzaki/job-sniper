import type { Opportunity } from '../domain/opportunity.js';
import { normalizeText } from '../text.js';

const CONTROL = ' Você ainda controla briefing, decisões e entrega.';

/**
 * Deterministic "how AI can help" sentences, chosen from the signals written in the title and description themselves
 * (skill tags are ignored: they are often generic). No AI is called. The sentences describe what AI can speed up in that
 * kind of work; they never say the person masters the skill. Order matters, most specific first: WordPress, then
 * front-end work (named technologies), then automation, integrations and bug fixes, and last a plainly stated request to
 * build a site or app. With no clear signal there is no sentence, and the block is omitted.
 */
const KINDS: { pattern: RegExp; text: string }[] = [
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
    pattern: /\b(apis?|integra\w*|integrations?|webhooks?)\b/,
    text: `Ajudar a esboçar as chamadas, o tratamento de erros e os testes básicos da integração.${CONTROL}`,
  },
  {
    pattern: /\b(bugs?|debug\w*|fix|fixes|corrig\w*|correc\w*|conserto|consertar)\b/,
    text: `Ajudar a investigar a causa, sugerir correções e revisar o resultado.${CONTROL}`,
  },
  {
    pattern: /\b(build|create|develop|criar|criacao|desenvolv\w*|construir)\b.{0,40}\b(websites?|web sites?|sites?|web ?apps?|sistemas?)\b/,
    text: `Acelerar a estrutura inicial, os componentes e a revisão responsiva.${CONTROL}`,
  },
];

/** A sentence for a kind of work that is clearly present, or null: with no clear signal the block is omitted. */
export function aiHelpFor(opportunity: Pick<Opportunity, 'title' | 'description'>, safe: boolean): string | null {
  if (!safe) return null;
  const text = normalizeText(`${opportunity.title}\n${opportunity.description}`);
  return KINDS.find((kind) => kind.pattern.test(text))?.text ?? null;
}

/** Only work with no advanced scope, and whose skills are really named in the text, is safe to describe. */
export function isSafeForAiHelp(decision: 'shortlist' | 'review' | 'skip', reasons: readonly string[]): boolean {
  return decision !== 'skip' && !reasons.some((reason) => reason.startsWith('conflicting or advanced scope') || reason.startsWith('strong skills appear only as tags'));
}
