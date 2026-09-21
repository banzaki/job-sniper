import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigError, loadAppConfig } from '../config.js';
import { runCommand, tick, type HunterResult } from '../agent/hunter.js';
import { loadHunterConfig } from '../agent/hunter-config.js';
import { parseIntent, parseVerb, type Parsed } from '../agent/intent.js';
import { runPipelineChild } from '../agent/pipeline-runner.js';
import { hunterFiles } from '../agent/state.js';
import { createNotifier } from '../notify/create-notifier.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

const USAGE = 'Usage: npm run hunter -- <status|hunt [freelancer|99freelas]|top [N]|more|help|ask|tick> [--sender <id> --chat <id>] [--text "<phrase>"]';
const VERBS = new Set(['status', 'hunt', 'top', 'more', 'help', 'ask', 'tick']);

/** Process exit codes: 0 ok, 1 failed, 2 invalid request, 3 not authorized or disabled, 4 busy, 5 configuration. */
const EXIT: Record<HunterResult['code'], number> = { ok: 0, failed: 1, invalid: 2, unauthorized: 3, disabled: 3, busy: 4, config: 5 };

interface Args {
  verb: string;
  positional: string[];
  sender: string | null;
  chat: string | null;
  text: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  let sender: string | null = null;
  let chat: string | null = null;
  let text: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--sender' || arg === '--chat' || arg === '--text') {
      const value = argv[(index += 1)];
      if (value === undefined) throw new Error(`${arg} needs a value. ${USAGE}`);
      if (arg === '--text') text = value;
      // A Telegram group or channel id is negative: it must reach the authorization check and be refused there, silently.
      else if (!(arg === '--chat' ? /^-?[0-9]{1,20}$/ : /^[0-9]{1,20}$/).test(value)) throw new Error(`${arg} must be a numeric Telegram id. ${USAGE}`);
      else if (arg === '--sender') sender = value;
      else chat = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument "${arg}". ${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  const [verb, ...rest] = positional;
  if (verb === undefined || !VERBS.has(verb)) throw new Error(`Unknown command. ${USAGE}`);
  return { verb, positional: rest, sender, chat, text };
}

const emit = (result: HunterResult): number => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return EXIT[result.code];
};

/**
 * The one stable entry point of the Hunter for the OpenClaw agent, the Telegram commands and the schedule: fixed verbs, validated
 * arguments, ONE line of JSON on stdout ({ ok, code, command, reply, data }), nothing else there. It runs the normal pipeline for a
 * hunt, and never a free command. The single Telegram user allowed is HUNTER_OWNER_TELEGRAM_ID.
 */
async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    return emit({ ok: false, code: 'invalid', command: 'none', reply: 'Comando inválido. Escreva "ajuda".', data: { error: error instanceof Error ? error.message : String(error) } });
  }

  let parsed: Parsed;
  try {
    const appConfig = loadAppConfig();
    const hunter = loadHunterConfig();
    const files = hunterFiles(appConfig.databasePath);
    const log = (record: Record<string, unknown>): void => {
      try {
        mkdirSync(dirname(files.log), { recursive: true });
        appendFileSync(files.log, `${JSON.stringify(record)}\n`);
      } catch {
        /* the log is best effort */
      }
    };
    parsed = args.verb === 'ask' ? (args.text === null ? { ok: false, reason: 'unknown' } : parseIntent(args.text, hunter.topMax)) : parseVerb(args.verb, args.positional, hunter.topMax);

    const store = new OpportunityStore(appConfig.databasePath);
    try {
      const deps = { appConfig, hunter, store, files, now: () => new Date(), runPipeline: runPipelineChild, createNotifier: () => createNotifier(appConfig), log };
      if (args.verb === 'tick') {
        const outcome = await tick(deps);
        log({ at: new Date().toISOString(), command: 'tick', code: outcome.code, dryRun: appConfig.dryRun });
        return emit(outcome);
      }
      return emit(await runCommand(deps, { sender: args.sender, chat: args.chat, parsed }));
    } finally {
      store.close();
    }
  } catch (error) {
    // A configuration problem names the variable, never a value; anything else is reported without details.
    if (error instanceof ConfigError) return emit({ ok: false, code: 'config', command: args.verb, reply: `⚠️ Configuração: ${error.message}`, data: { error: error.message } });
    return emit({ ok: false, code: 'failed', command: args.verb, reply: '⚠️ Falha inesperada; veja o log do Hunter.', data: {} });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 1;
  },
);
