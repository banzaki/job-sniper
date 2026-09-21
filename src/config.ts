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
  /** Sources collected in each run, in this order. Defaults to the 99Freelas source alone. */
  sources: SourceName[];
  /** Hours between two queries to the Remotive API (at least 6; failed attempts count too). */
  remotiveMinIntervalHours: number;
  /** Most Telegram alerts sent in one run, across all sources; the rest stay pending, unmarked. */
  maxTelegramAlertsPerRun: number;
  /** Listing pages of 20 projects read from Freelancer.com per run (1 to 10). Only this source reads it. */
  freelancerMaxPages: number;
  /** Freelancer.com Personal Access Token (valid 30 days); null when unset, which only disables that source. Never printed. */
  freelancerToken: string | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
}

export const DEFAULT_DATABASE_PATH = './data/job-sniper.db';
// Independent limits per run (none of them promises to cover the whole site):
export const DEFAULT_MAX_DETAILS_PER_RUN = 20; // detail requests, shared between new and older pending items
export const DEFAULT_DISCOVERY_MAX_PAGES = 20; // listing pages, newest first
export const DEFAULT_DISCOVERY_TARGET_NEW = 100; // new summaries saved to the queue before pagination stops
export const SOURCE_NAMES = ['99freelas', 'remotive', 'freelancer'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];
export const DEFAULT_SOURCES: readonly SourceName[] = ['99freelas'];
/** The Remotive documentation advises at most 4 queries a day. */
export const DEFAULT_REMOTIVE_MIN_INTERVAL_HOURS = 6;
/** Freelancer.com listing pages per run (20 projects each): default, lowest and highest accepted value. */
export const DEFAULT_FREELANCER_MAX_PAGES = 5;
export const MIN_FREELANCER_MAX_PAGES = 1;
export const MAX_FREELANCER_MAX_PAGES = 10;
/** Alerts per run: a small, ranked batch instead of a flood. */
export const DEFAULT_MAX_TELEGRAM_ALERTS_PER_RUN = 5;
export const DEFAULT_NOTIFY_DECISIONS: readonly FilterDecision[] = ['top_match', 'shortlist', 'review'];

const DECISIONS: readonly FilterDecision[] = ['top_match', 'shortlist', 'review', 'skip'];

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

  const sources = parseSources(env.SOURCES, warn);
  const remotiveMinIntervalHours = sources.includes('remotive')
    ? atLeast(env, 'REMOTIVE_MIN_INTERVAL_HOURS', DEFAULT_REMOTIVE_MIN_INTERVAL_HOURS, DEFAULT_REMOTIVE_MIN_INTERVAL_HOURS)
    : DEFAULT_REMOTIVE_MIN_INTERVAL_HOURS;

  const freelancerMaxPages = sources.includes('freelancer')
    ? between(env, 'FREELANCER_MAX_PAGES', DEFAULT_FREELANCER_MAX_PAGES, MIN_FREELANCER_MAX_PAGES, MAX_FREELANCER_MAX_PAGES)
    : DEFAULT_FREELANCER_MAX_PAGES;

  return {
    databasePath,
    maxDetailsPerRun,
    discoveryMaxPages,
    discoveryTargetNew,
    dryRun,
    notifyDecisions: parseDecisions(env.TELEGRAM_NOTIFY_DECISIONS, warn),
    sources,
    remotiveMinIntervalHours,
    maxTelegramAlertsPerRun: positiveInteger(env, 'MAX_TELEGRAM_ALERTS_PER_RUN', DEFAULT_MAX_TELEGRAM_ALERTS_PER_RUN),
    freelancerMaxPages,
    freelancerToken: env.FREELANCER_OAUTH_TOKEN?.trim() || null,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    telegramChatId: env.TELEGRAM_CHAT_ID?.trim() || null,
  };
}

export interface AiConfig {
  enabled: boolean;
  provider: string;
  model: string;
  apiKey: string | null;
  /** Analyses attempted per run, 1-20. */
  maxAnalysesPerRun: number;
  /** Minimum seconds between the start of two provider requests, retries included. */
  minIntervalSeconds: number;
  /** Most provider requests (attempts, retries included) per quota day, as counted by this app. */
  maxRequestsPerDay: number;
}

export const DEFAULT_AI_PROVIDER = 'gemini';
export const DEFAULT_AI_MODEL = 'gemini-3.6-flash';
export const DEFAULT_AI_MAX_ANALYSES_PER_RUN = 20;
/** Analyses are batched in groups of at most this many. */
export const AI_MAX_ANALYSES_LIMIT = 20;
// Limits observed for this project's free tier on gemini-3.6-flash: 5 requests/minute and 20 requests/day.
// They belong to that account, not to Gemini in general, so both are configurable.
export const DEFAULT_GEMINI_MIN_INTERVAL_SECONDS = 15;
export const DEFAULT_GEMINI_MAX_REQUESTS_PER_DAY = 20;

/**
 * AI settings, read separately from the rest so a typo here can never break commands that do not use AI.
 * While AI_ENABLED is not exactly "true" nothing else is validated. When enabled, an unsupported
 * provider or an invalid AI_MAX_ANALYSES_PER_RUN fails with a ConfigError naming the variable.
 * The API key is only required when a real request is about to be made (see requireGeminiKey).
 */
export function loadAiConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): AiConfig {
  const rawEnabled = env.AI_ENABLED?.trim().toLowerCase();
  if (rawEnabled && rawEnabled !== 'true' && rawEnabled !== 'false') {
    warn('Ignoring invalid AI_ENABLED value; AI stays disabled. Use "true" or "false".');
  }
  const enabled = rawEnabled === 'true';

  const base = {
    enabled,
    provider: env.AI_PROVIDER?.trim().toLowerCase() || DEFAULT_AI_PROVIDER,
    model: env.AI_MODEL?.trim() || DEFAULT_AI_MODEL,
    apiKey: env.GEMINI_API_KEY?.trim() || null,
  };
  if (!enabled) {
    return {
      ...base,
      maxAnalysesPerRun: DEFAULT_AI_MAX_ANALYSES_PER_RUN,
      minIntervalSeconds: DEFAULT_GEMINI_MIN_INTERVAL_SECONDS,
      maxRequestsPerDay: DEFAULT_GEMINI_MAX_REQUESTS_PER_DAY,
    };
  }

  if (base.provider !== 'gemini') {
    throw new ConfigError(`AI_PROVIDER "${base.provider}" is not supported. Only "gemini" is available.`);
  }
  const maxAnalysesPerRun = positiveInteger(env, 'AI_MAX_ANALYSES_PER_RUN', DEFAULT_AI_MAX_ANALYSES_PER_RUN);
  if (maxAnalysesPerRun > AI_MAX_ANALYSES_LIMIT) {
    throw new ConfigError(`AI_MAX_ANALYSES_PER_RUN must be at most ${AI_MAX_ANALYSES_LIMIT}, but got ${maxAnalysesPerRun}.`);
  }
  return {
    ...base,
    maxAnalysesPerRun,
    minIntervalSeconds: positiveInteger(env, 'GEMINI_MIN_INTERVAL_SECONDS', DEFAULT_GEMINI_MIN_INTERVAL_SECONDS),
    maxRequestsPerDay: positiveInteger(env, 'GEMINI_MAX_REQUESTS_PER_DAY', DEFAULT_GEMINI_MAX_REQUESTS_PER_DAY),
  };
}

/** The Gemini API key, required only when a real request is about to be made. Never echoed. */
export function requireGeminiKey(config: AiConfig): string {
  if (!config.apiKey) {
    throw new ConfigError('Missing GEMINI_API_KEY in .env. Fill it in locally, or keep DRY_RUN=true / AI_ENABLED=false.');
  }
  return config.apiKey;
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
  // A malformed token otherwise surfaces as a confusing HTTP 404 from Telegram. Only counts are reported.
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(config.telegramBotToken)) {
    const parts = config.telegramBotToken.split(':').length;
    throw new ConfigError(
      `TELEGRAM_BOT_TOKEN has an unexpected format: expected "<bot id>:<secret>" with exactly one colon, ` +
        `found ${parts} colon-separated part(s), ${config.telegramBotToken.length} characters. Check the value in .env.`,
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

/** Unset or blank gives the default; a positive integer below `minimum` is refused (the run fails). */
function atLeast(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const value = positiveInteger(env, name, fallback);
  if (value < minimum) throw new ConfigError(`${name} must be at least ${minimum}, but got ${value}.`);
  return value;
}

/** Unset or blank gives the default; a positive integer outside [minimum, maximum] is refused (the run fails). */
function between(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = positiveInteger(env, name, fallback);
  if (value < minimum || value > maximum) throw new ConfigError(`${name} must be between ${minimum} and ${maximum}, but got ${value}.`);
  return value;
}

/** A comma-separated list of known source names; unknown names are ignored with a warning, none valid gives the default. */
function parseSources(raw: string | undefined, warn: (message: string) => void): SourceName[] {
  if (!raw?.trim()) return [...DEFAULT_SOURCES];
  const sources: SourceName[] = [];
  for (const item of raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    const name = SOURCE_NAMES.find((candidate) => candidate === item);
    if (name) {
      if (!sources.includes(name)) sources.push(name);
    } else {
      warn(`Ignoring unknown source "${item}" in SOURCES. Known sources: ${SOURCE_NAMES.join(', ')}.`);
    }
  }
  return sources.length > 0 ? sources : [...DEFAULT_SOURCES];
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
  // Compatibility: whoever asked for `shortlist` before `top_match` existed also receives it (an excellent match is a
  // better shortlist). Only an explicit list without `shortlist` can leave it out.
  if (decisions.includes('shortlist') && !decisions.includes('top_match')) decisions.unshift('top_match');
  return decisions.length > 0 ? decisions : [...DEFAULT_NOTIFY_DECISIONS];
}
