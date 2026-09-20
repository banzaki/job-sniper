import { requireTelegramCredentials, type AppConfig } from '../config.js';
import { ConsoleNotifier, type Notifier } from './notifier.js';
import { TelegramNotifier } from './telegram-notifier.js';

/**
 * DRY_RUN=true gives a notifier that only prints. Otherwise Telegram is used, and its
 * credentials are validated here, so a missing variable fails before anything is attempted.
 */
export function createNotifier(config: AppConfig): Notifier {
  if (config.dryRun) return new ConsoleNotifier();
  const { botToken, chatId } = requireTelegramCredentials(config);
  return new TelegramNotifier(botToken, chatId);
}
