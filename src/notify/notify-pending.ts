import type { FilterDecision } from '../domain/filter-result.js';
import { formatOpportunityMessage, type FormatOptions } from './format-message.js';
import { NotificationError, type Notifier } from './notifier.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';

export interface NotifyOptions {
  store: OpportunityStore;
  notifier: Notifier;
  decisions: readonly FilterDecision[];
  /** In dry-run nothing is marked as notified, whatever the notifier does. */
  dryRun: boolean;
  format?: FormatOptions;
  now?: () => Date;
}

export interface NotifyReport {
  pending: number;
  /** Confirmed by the channel and marked as notified. */
  sent: number;
  /** Dry-run only: messages rendered but not sent. */
  rendered: number;
  failures: { id: string; message: string }[];
  /** Set when a failure made further sending pointless; remaining items stay pending. */
  aborted: string | null;
}

/**
 * Sends every stored opportunity that has one of the chosen decisions and was never notified,
 * one at a time. An item is marked notified only after the channel confirms delivery, so a
 * failure leaves it pending for the next run. Works on everything in the database, not only
 * on what the current run discovered.
 */
export async function notifyPending(options: NotifyOptions): Promise<NotifyReport> {
  const { store, notifier, decisions, dryRun } = options;
  const now = options.now ?? (() => new Date());
  const report: NotifyReport = { pending: 0, sent: 0, rendered: 0, failures: [], aborted: null };

  const keys = store.listPendingNotification(decisions);
  report.pending = keys.length;

  for (const key of keys) {
    const id = `${key.sourceId}:${key.externalId}`;
    try {
      const stored = store.get(key);
      if (!stored) continue;
      await notifier.send(formatOpportunityMessage(stored.opportunity, stored.filter, options.format));
      if (dryRun) {
        report.rendered += 1;
      } else {
        store.markNotified(key, now().toISOString());
        report.sent += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failures.push({ id, message });
      if (error instanceof NotificationError && error.fatal) {
        report.aborted = message;
        break;
      }
    }
  }

  return report;
}
