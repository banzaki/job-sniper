import { NotificationError, type Notifier } from './notifier.js';

const API_BASE = 'https://api.telegram.org';
/** Telegram accepts at most 4096 characters per message. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
/** HTTP statuses that mean every further message would fail the same way. */
const FATAL_STATUSES = new Set([401, 403, 404, 429]);

export interface TelegramOptions {
  timeoutMs: number;
  /** Minimum gap between messages (Telegram allows roughly one per second per chat). */
  minIntervalMs: number;
}

const DEFAULT_OPTIONS: TelegramOptions = { timeoutMs: 15_000, minIntervalMs: 1_100 };

/**
 * Sends HTML-formatted messages through the Telegram Bot API with native fetch.
 * The token lives only in the request URL, which is never logged; every error message
 * is scrubbed of the token before it leaves this class.
 */
export class TelegramNotifier implements Notifier {
  private readonly token: string;
  private readonly chatId: string;
  private readonly options: TelegramOptions;
  private lastSentAt = 0;

  constructor(token: string, chatId: string, options: Partial<TelegramOptions> = {}) {
    this.token = token;
    this.chatId = chatId;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async send(text: string): Promise<void> {
    if (text.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
      throw new NotificationError(`Message has ${text.length} characters; Telegram allows ${TELEGRAM_MAX_MESSAGE_LENGTH}.`);
    }
    await this.throttle();

    let response: Response;
    try {
      response = await fetch(`${API_BASE}/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new NotificationError(`Telegram request timed out after ${this.options.timeoutMs}ms; delivery is unconfirmed.`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new NotificationError(`Telegram request failed: ${this.scrub(reason)}`);
    }

    const body = await response.json().catch(() => null);
    const apiOk = isRecord(body) && body.ok === true;
    if (!response.ok || !apiOk) {
      const description = isRecord(body) && typeof body.description === 'string' ? body.description : 'no description';
      throw new NotificationError(
        `Telegram API refused the message (HTTP ${response.status}): ${this.scrub(description)}`,
        FATAL_STATUSES.has(response.status),
      );
    }
  }

  private async throttle(): Promise<void> {
    const wait = this.lastSentAt + this.options.minIntervalMs - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastSentAt = Date.now();
  }

  /** Removes the token, and anything shaped like a bot token, from text that may be shown. */
  private scrub(text: string): string {
    return text.split(this.token).join('[redacted]').replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '[redacted]');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
