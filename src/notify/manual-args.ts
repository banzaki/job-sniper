import type { OpportunityKey } from '../domain/opportunity.js';

export interface ManualArgs {
  key: OpportunityKey;
  /** True only when the owner typed --send. Without it nothing is sent, stored or marked. */
  send: boolean;
}

/** What the owner sees when --send meets DRY_RUN=true. */
export const SEND_BLOCKED_MESSAGE = 'Envio bloqueado: DRY_RUN=true. Defina DRY_RUN=false para autorizar envio real.';

/**
 * A real send needs three things together: an explicit --send, DRY_RUN=false and valid credentials (checked when the notifier is created).
 * DRY_RUN=true blocks every external send, these two manual commands included. Called BEFORE the database or Telegram is touched, so a
 * blocked send changes nothing. Without --send nothing is ever sent, whatever DRY_RUN says.
 */
export function assertSendAllowed(send: boolean, dryRun: boolean): void {
  if (send && dryRun) throw new Error(SEND_BLOCKED_MESSAGE);
}

/** Words that would mean "everything": a manual command never accepts them. */
const BATCH_WORDS = new Set(['all', 'todos', 'todas', '*', 'batch', 'backlog']);

/**
 * The arguments of `notify:preview` and `notify:manual`: EXACTLY ONE `--only <source>:<id>` and an optional `--send`.
 * A list, a repeated --only, an empty value, "all" or any implicit batch is refused, so a typo can never send several
 * messages. Throws an Error whose message states what is wrong and shows the usage.
 */
export function parseManualArgs(argv: readonly string[], usage: string): ManualArgs {
  let raw: string | null = null;
  let send = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--send') {
      if (send) throw new Error(`--send was given twice. ${usage}`);
      send = true;
    } else if (arg === '--only') {
      if (raw !== null) throw new Error(`Give exactly one --only <source>:<id>; it was given more than once. ${usage}`);
      raw = (argv[(index += 1)] ?? '').trim();
    } else {
      throw new Error(`Unknown argument "${String(arg)}". ${usage}`);
    }
  }
  if (raw === null || raw === '') throw new Error(`Missing --only <source>:<id>. ${usage}`);
  if (BATCH_WORDS.has(raw.toLowerCase())) throw new Error(`"${raw}" is not accepted: give exactly one opportunity as <source>:<id>. ${usage}`);
  if (/[\s,;]/.test(raw)) throw new Error(`Give exactly one <source>:<id>, without a list or spaces (got "${raw}"). ${usage}`);
  const separator = raw.indexOf(':');
  if (separator < 1 || separator === raw.length - 1) throw new Error(`"${raw}" is not a <source>:<id> key. ${usage}`);
  return { key: { sourceId: raw.slice(0, separator), externalId: raw.slice(separator + 1) }, send };
}
