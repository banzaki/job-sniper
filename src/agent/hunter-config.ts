import { config as loadDotenv } from 'dotenv';
import { ConfigError } from '../config.js';

export interface HunterConfig {
  /** The Hunter answers nothing until this is true. */
  enabled: boolean;
  /** The single Telegram user id (digits) allowed to command the Hunter; null when unset. Never printed. */
  ownerTelegramId: string | null;
  /** IANA time zone of the schedule. */
  timezone: string;
  scheduleEnabled: boolean;
  /** Local times "HH:MM", sorted and unique. */
  scheduleTimes: string[];
  /** Most results `top` may show (1 to 10). */
  topMax: number;
}

export const DEFAULT_HUNTER_TIMEZONE = 'America/Sao_Paulo';
export const DEFAULT_HUNTER_SCHEDULE_TIMES = ['09:00', '17:00'];
export const DEFAULT_HUNTER_TOP_MAX = 10;
export const HUNTER_TOP_LIMIT = 10;

const isTruthy = (raw: string | undefined): boolean => raw?.trim().toLowerCase() === 'true';

/** A valid IANA zone is one Intl accepts. */
export const isValidTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** Loads `.env` (if present), then reads the Hunter settings. */
export function loadHunterConfig(): HunterConfig {
  loadDotenv({ quiet: true });
  return readHunterConfig();
}

/**
 * Reads the Hunter settings. Anything unusable fails with a message that names the variable and never its value; a schedule
 * or an owner that is not configured is never guessed. The owner id is required only when the Hunter is enabled.
 */
export function readHunterConfig(env: NodeJS.ProcessEnv = process.env): HunterConfig {
  const enabled = isTruthy(env.HUNTER_ENABLED);
  const rawOwner = env.HUNTER_OWNER_TELEGRAM_ID?.trim() || '';
  if (rawOwner !== '' && !/^[0-9]{3,15}$/.test(rawOwner)) {
    throw new ConfigError('HUNTER_OWNER_TELEGRAM_ID must be the numeric Telegram user id (3 to 15 digits), never a user name.');
  }
  if (enabled && rawOwner === '') {
    throw new ConfigError('Missing HUNTER_OWNER_TELEGRAM_ID in .env. The Hunter needs the one Telegram user id it obeys; fill it in locally or keep HUNTER_ENABLED=false.');
  }

  const timezone = env.HUNTER_TIMEZONE?.trim() || DEFAULT_HUNTER_TIMEZONE;
  if (!isValidTimeZone(timezone)) throw new ConfigError('HUNTER_TIMEZONE is not a valid IANA time zone (for example America/Sao_Paulo).');

  const rawTimes = env.HUNTER_SCHEDULE_TIMES?.trim();
  const times = rawTimes ? rawTimes.split(',').map((part) => part.trim()).filter(Boolean) : DEFAULT_HUNTER_SCHEDULE_TIMES;
  for (const time of times) {
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) throw new ConfigError('HUNTER_SCHEDULE_TIMES must be a comma-separated list of 24-hour times "HH:MM", for example 09:00,17:00.');
  }
  if (times.length === 0 || times.length > 12) throw new ConfigError('HUNTER_SCHEDULE_TIMES must list from 1 to 12 times.');

  const rawTop = env.HUNTER_TOP_MAX?.trim();
  const topMax = rawTop ? Number(rawTop) : DEFAULT_HUNTER_TOP_MAX;
  if (!/^[0-9]+$/.test(rawTop ?? '0') || !Number.isInteger(topMax) || topMax < 1 || topMax > HUNTER_TOP_LIMIT) {
    throw new ConfigError(`HUNTER_TOP_MAX must be a whole number from 1 to ${HUNTER_TOP_LIMIT}.`);
  }

  return { enabled, ownerTelegramId: rawOwner || null, timezone, scheduleEnabled: isTruthy(env.HUNTER_SCHEDULE_ENABLED), scheduleTimes: [...new Set(times)].sort(), topMax };
}
