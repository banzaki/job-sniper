export interface SendOptions {
  /** No sound or vibration on the recipient's device. Used for continuation parts. */
  silent?: boolean;
}

export interface SendResult {
  /** The channel's id for the delivered message, when it reports one. */
  messageId: string | null;
}

/** Delivers one rendered message. Implementations must throw when delivery is not confirmed. */
export interface Notifier {
  send(text: string, options?: SendOptions): Promise<SendResult | void>;
}

export class NotificationError extends Error {
  /** True when retrying the remaining messages is pointless (bad credentials, rate limit). */
  readonly fatal: boolean;
  /**
   * True when the message may have been delivered anyway (timeout, lost reply). Such a message must not be
   * blindly re-sent right away: the ambiguity is recorded and resolved by a later run.
   */
  readonly ambiguous: boolean;

  constructor(message: string, fatal = false, ambiguous = false) {
    super(message);
    this.name = 'NotificationError';
    this.fatal = fatal;
    this.ambiguous = ambiguous;
  }
}

/** Dry-run notifier: prints what would be sent and sends nothing. */
export class ConsoleNotifier implements Notifier {
  async send(text: string, options: SendOptions = {}): Promise<SendResult> {
    console.log(`----- [DRY_RUN] message rendered, NOT sent${options.silent ? ' (silent)' : ''} -----`);
    console.log(text);
    console.log('-----------------------------------------------');
    return { messageId: null };
  }
}
