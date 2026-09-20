/** Delivers one rendered message. Implementations must throw when delivery is not confirmed. */
export interface Notifier {
  send(text: string): Promise<void>;
}

export class NotificationError extends Error {
  /** True when retrying the remaining messages is pointless (bad credentials, rate limit). */
  readonly fatal: boolean;

  constructor(message: string, fatal = false) {
    super(message);
    this.name = 'NotificationError';
    this.fatal = fatal;
  }
}

/** Dry-run notifier: prints what would be sent and sends nothing. */
export class ConsoleNotifier implements Notifier {
  async send(text: string): Promise<void> {
    console.log('----- [DRY_RUN] message rendered, NOT sent -----');
    console.log(text);
    console.log('-----------------------------------------------');
  }
}
