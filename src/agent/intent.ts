/**
 * The whole vocabulary of the Hunter. Text that does not match one of these intents exactly authorizes NOTHING: it is answered with
 * a refusal or the help text. The parser is deterministic (no model), and it is the only place where words become an action.
 */
export type HuntSource = 'all' | 'freelancer' | '99freelas';

export type Intent =
  | { kind: 'status' }
  | { kind: 'hunt'; source: HuntSource }
  | { kind: 'top'; count: number }
  | { kind: 'more'; count: 5 }
  | { kind: 'help' };

export type RefusalReason =
  | 'auto_apply' // "candidate-se nessa vaga"
  | 'profile' // "mude meu perfil"
  | 'multi_source' // "ache 40 em quatro sites"
  | 'shell' // "execute este comando"
  | 'source_not_allowed' // a source outside the catalogue (Remotive by name, others)
  | 'bad_count' // a number outside the limits
  | 'unknown';

export type Parsed = { ok: true; intent: Intent } | { ok: false; reason: RefusalReason };

/** The batch a `more` releases is fixed. */
export const MORE_BATCH = 5;

/** Lower case, no accents, no ending punctuation, single spaces. Only letters, digits and spaces survive the catalogue match. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SOURCE_WORDS: Record<string, HuntSource> = { freelancer: 'freelancer', 'freelancer.com': 'freelancer', '99freelas': '99freelas', '99 freelas': '99freelas' };

/** Every phrase the catalogue accepts, as a list of examples (used by the help text and by the integration's argument pattern). */
export const CATALOGUE_PHRASES = ['status', 'caça agora', 'caça agora só no Freelancer', 'caça agora só no 99Freelas', 'mostre as N melhores', 'libere mais 5', 'ajuda'] as const;

export function parseIntent(text: string, topMax: number): Parsed {
  const t = normalizeText(text);
  if (t === 'status') return { ok: true, intent: { kind: 'status' } };
  if (t === 'ajuda' || t === 'help') return { ok: true, intent: { kind: 'help' } };
  if (t === 'caca agora') return { ok: true, intent: { kind: 'hunt', source: 'all' } };

  const only = /^caca agora so no (.+)$/.exec(t);
  if (only) {
    const source = SOURCE_WORDS[only[1]!];
    return source ? { ok: true, intent: { kind: 'hunt', source } } : { ok: false, reason: 'source_not_allowed' };
  }

  const top = /^mostre as ([0-9]{1,4}) melhores$/.exec(t);
  if (top) {
    const count = Number(top[1]);
    return count >= 1 && count <= Math.min(topMax, 10) ? { ok: true, intent: { kind: 'top', count } } : { ok: false, reason: 'bad_count' };
  }

  const more = /^libere mais ([0-9]{1,4})$/.exec(t);
  if (more) return Number(more[1]) === MORE_BATCH ? { ok: true, intent: { kind: 'more', count: MORE_BATCH } } : { ok: false, reason: 'bad_count' };

  // Not authorizations: only the reason for the refusal, so the answer can be useful.
  if (/\b(candidat|aplique|aplicar|envie proposta|mande proposta)/.test(t)) return { ok: false, reason: 'auto_apply' };
  if (/\b(perfil|curriculo|habilidades)\b/.test(t) && /\b(mude|muda|altere|troque|atualize)/.test(t)) return { ok: false, reason: 'profile' };
  if (/\b(quatro|4|40|quarenta)\b/.test(t) && /\b(site|sites|vagas)\b/.test(t)) return { ok: false, reason: 'multi_source' };
  if (/\b(execute|executar|rode|rodar|comando|terminal|shell|bash|powershell|npm|node)\b/.test(t)) return { ok: false, reason: 'shell' };
  return { ok: false, reason: 'unknown' };
}

/** The strict forms of the slash commands: `/hunt [source]`, `/top [N]`, `/more`, `/status`, `/help`. */
export function parseVerb(verb: string, args: readonly string[], topMax: number): Parsed {
  const bad = (reason: RefusalReason): Parsed => ({ ok: false, reason });
  switch (verb) {
    case 'status':
    case 'help':
      return args.length === 0 ? { ok: true, intent: { kind: verb } } : bad('unknown');
    case 'hunt': {
      if (args.length === 0) return { ok: true, intent: { kind: 'hunt', source: 'all' } };
      const source = args.length === 1 ? SOURCE_WORDS[normalizeText(args[0]!)] : undefined;
      return source ? { ok: true, intent: { kind: 'hunt', source } } : bad('source_not_allowed');
    }
    case 'top': {
      const raw = args.length === 0 ? '5' : args.length === 1 ? args[0]! : 'x';
      const count = /^[0-9]{1,4}$/.test(raw) ? Number(raw) : 0;
      return count >= 1 && count <= Math.min(topMax, 10) ? { ok: true, intent: { kind: 'top', count } } : bad('bad_count');
    }
    case 'more': {
      const raw = args.length === 0 ? String(MORE_BATCH) : args.length === 1 ? args[0]! : 'x';
      return raw === String(MORE_BATCH) ? { ok: true, intent: { kind: 'more', count: MORE_BATCH } } : bad('bad_count');
    }
    default:
      return bad('unknown');
  }
}

/** Short Portuguese answers for what was not authorized. */
export const REFUSALS: Record<RefusalReason, string> = {
  auto_apply: 'Não existe candidatura automática. Eu só caço e aviso; você se candidata pelo link.',
  profile: 'Ainda não é suportado mudar o perfil por aqui.',
  multi_source: 'A V1 ainda não tem quatro fontes freelance válidas. Hoje caço no Freelancer e no 99Freelas.',
  shell: 'Não executo comandos livres. Só o catálogo: status, caça agora, mostre as N melhores, libere mais 5, ajuda.',
  source_not_allowed: 'Só caço em todas as fontes ligadas, no Freelancer ou no 99Freelas.',
  bad_count: 'Número fora dos limites: mostre de 1 a 10 melhores; libere sempre 5.',
  unknown: 'Esse comando não está disponível no Hunter V1.',
};

/** The whole catalogue, verbatim, and nothing else: the fixed text of "ajuda". */
export const HELP_TEXT = [
  '🎯 O que eu faço:',
  '• status',
  '• caça agora',
  '• caça agora só no Freelancer',
  '• caça agora só no 99Freelas',
  '• mostre as N melhores (N entre 1 e 10)',
  '• libere mais 5',
  '• ajuda',
].join('\n');
