import { config as loadDotenv } from 'dotenv';
import type { FilterDecision } from './domain/filter-result.js';

export interface AppConfig {
  databasePath: string;
  maxDetailsPerRun: number;
  /** Most listing pages read per run, starting from the newest. */
  discoveryMaxPages: number;
  /** Stop paginating once this many unseen opportunities were collected. */
  discoveryTargetNew: number;
  /** When true nothing is sent anywhere and nothing is marked as notified. Defaults to true. */
  dryRun: boolean;
  notifyDecisions: FilterDecision[];
  telegramBotToken: string | null;
  telegramChatId: string | null;
}

export const DEFAULT_DATABASE_PATH = './data/job-sniper.db';
export const DEFAULT_MAX_DETAILS_PER_RUN = 10;
export const DEFAULT_DISCOVERY_MAX_PAGES = 5;
export const DEFAULT_DISCOVERY_TARGET_NEW = 10;
export const DEFAULT_NOTIFY_DECISIONS: readonly FilterDecision[] = ['shortlist', 'review'];

const DECISIONS: readonly FilterDecision[] = ['shortlist', 'review', 'skip'];

/** Missing or unusable configuration. Messages name variables, never their values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Loads `.env` (if present) into the environment, then reads the settings. */
export function loadAppConfig(): AppConfig {
  loadDotenv({ quiet: true });
  return loadConfig();
}

/** Reads settings from the environment, falling back to safe defaults and warning on bad values. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): AppConfig {
  const databasePath = env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;

  let maxDetailsPerRun = DEFAULT_MAX_DETAILS_PER_RUN;
  const rawMax = env.MAX_DETAILS_PER_RUN?.trim();
  if (rawMax) {
    const parsed = Number(rawMax);
    if (Number.isInteger(parsed) && parsed >= 1) {
      maxDetailsPerRun = parsed;
    } else {
      warn(`Ignoring invalid MAX_DETAILS_PER_RUN="${rawMax}"; using ${DEFAULT_MAX_DETAILS_PER_RUN}.`);
    }
  }

  const discoveryMaxPages = positiveInteger(env, 'DISCOVERY_MAX_PAGES', DEFAULT_DISCOVERY_MAX_PAGES);
  const discoveryTargetNew = positiveInteger(env, 'DISCOVERY_TARGET_NEW', DEFAULT_DISCOVERY_TARGET_NEW);

  // Anything other than an explicit "false" keeps dry-run on: the safe direction.
  let dryRun = true;
  const rawDryRun = env.DRY_RUN?.trim().toLowerCase();
  if (rawDryRun === 'false') {
    dryRun = false;
  } else if (rawDryRun && rawDryRun !== 'true') {
    warn('Ignoring invalid DRY_RUN value; staying in dry-run mode. Use "true" or "false".');
  }

  return {
    databasePath,
    maxDetailsPerRun,
    discoveryMaxPages,
    discoveryTargetNew,
    dryRun,
    notifyDecisions: parseDecisions(env.TELEGRAM_NOTIFY_DECISIONS, warn),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    telegramChatId: env.TELEGRAM_CHAT_ID?.trim() || null,
  };
}

/** Telegram credentials, required only when a real message is about to be sent. */
export function requireTelegramCredentials(config: AppConfig): { botToken: string; chatId: string } {
  const missing: string[] = [];
  if (!config.telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.telegramChatId) missing.push('TELEGRAM_CHAT_ID');
  if (!config.telegramBotToken || !config.telegramChatId) {
    throw new ConfigError(
      `Missing ${missing.join(' and ')} in .env. Fill them in locally, or keep DRY_RUN=true.`,
    );
  }
  return { botToken: config.telegramBotToken, chatId: config.telegramChatId };
}

/** Unset or blank gives the default; anything else must be a positive integer, or the run fails. */
function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ConfigError(`${name} must be a positive integer, but got "${raw}".`);
  }
  return Number(raw);
}

function parseDecisions(
  raw: string | undefined,
  warn: (message: string) => void,
): FilterDecision[] {
  if (!raw?.trim()) return [...DEFAULT_NOTIFY_DECISIONS];

  const decisions: FilterDecision[] = [];
  for (const item of raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    const decision = DECISIONS.find((candidate) => candidate === item);
    if (decision) {
      if (!decisions.includes(decision)) decisions.push(decision);
    } else {
      warn(`Ignoring unknown decision "${item}" in TELEGRAM_NOTIFY_DECISIONS.`);
    }
  }
  return decisions.length > 0 ? decisions : [...DEFAULT_NOTIFY_DECISIONS];
}
