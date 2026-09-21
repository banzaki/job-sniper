import type { FilterDecision } from '../domain/filter-result.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import {
  formatAnalysisMessage,
  formatOpportunityMessage,
  type FormatOptions,
} from './format-message.js';
import { NotificationError, type Notifier } from './notifier.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';

export interface NotifyOptions {
  store: OpportunityStore;
  notifier: Notifier;
  decisions: readonly FilterDecision[];
  /** In dry-run nothing is marked as notified, whatever the notifier does. */
  dryRun: boolean;
  /** Analysis version whose results may be announced. Omit to ignore AI analyses entirely. */
  analysisVersion?: string;
  /** When given, only these opportunities are considered; everything else stays untouched. */
  only?: readonly OpportunityKey[];
  format?: FormatOptions;
  now?: () => Date;
}

export interface NotifyReport {
  pending: number;
  /** Confirmed by the channel and marked as notified. */
  sent: number;
  /** Dry-run only: messages rendered but not sent. */
  rendered: number;
  /** Of the sent (or rendered) messages: basic filter message, AI-enriched first message, AI update. */
  kinds: { basic: number; enriched: number; aiUpdate: number };
  /** Basic notifications withheld because the AI judged the opportunity a clear skip. */
  suppressedBySkip: number;
  failures: { id: string; message: string }[];
  /** Set when a failure made further sending pointless; remaining items stay pending. */
  aborted: string | null;
}

interface Pending {
  key: OpportunityKey;
  /** The first (deterministic-filter) notification is still owed. */
  opportunity: boolean;
  /** An AI analysis result has never been announced. */
  analysis: boolean;
}

/**
 * Sends what is owed, one message at a time, from everything in the database (not only what this run
 * discovered). Two independent states are tracked: opportunities.notified_at (first notification) and
 * analyses.notified_at (the AI result), so neither is ever sent twice:
 *   both owed          -> one AI-enriched message, marks both;
 *   only analysis owed -> an "AI update" message (opportunity already notified, or filtered out);
 *   only first owed    -> the basic message (no analysis yet, or AI unavailable).
 * A clear AI skip is never announced, and it also withholds the basic message.
 * Marks are written only after the channel confirms delivery, and never in dry-run.
 */
export async function notifyPending(options: NotifyOptions): Promise<NotifyReport> {
  const { store, notifier, decisions, dryRun, analysisVersion } = options;
  const now = options.now ?? (() => new Date());
  const report: NotifyReport = {
    pending: 0,
    sent: 0,
    rendered: 0,
    kinds: { basic: 0, enriched: 0, aiUpdate: 0 },
    suppressedBySkip: 0,
    failures: [],
    aborted: null,
  };

  const pending = new Map<string, Pending>();
  const add = (key: OpportunityKey, field: 'opportunity' | 'analysis'): void => {
    const id = `${key.sourceId}:${key.externalId}`;
    const entry = pending.get(id) ?? { key, opportunity: false, analysis: false };
    entry[field] = true;
    pending.set(id, entry);
  };
  for (const key of store.listPendingNotification(decisions, analysisVersion)) add(key, 'opportunity');
  if (analysisVersion) {
    for (const key of store.analyses.listPendingNotification(analysisVersion)) add(key, 'analysis');
    report.suppressedBySkip =
      store.listPendingNotification(decisions).length - store.listPendingNotification(decisions, analysisVersion).length;
  }
  if (options.only) {
    const allowed = new Set(options.only.map((key) => `${key.sourceId}:${key.externalId}`));
    for (const id of [...pending.keys()]) if (!allowed.has(id)) pending.delete(id);
  }
  report.pending = pending.size;

  for (const [id, entry] of pending) {
    try {
      const stored = store.get(entry.key);
      if (!stored) continue;
      const analysis = analysisVersion && entry.analysis ? store.analyses.get(entry.key, analysisVersion) : null;

      let text: string;
      let kind: keyof NotifyReport['kinds'];
      if (analysis && entry.opportunity) {
        text = formatAnalysisMessage(stored.opportunity, stored.filter, analysis.analysis, 'enriched', options.format);
        kind = 'enriched';
      } else if (analysis) {
        text = formatAnalysisMessage(stored.opportunity, stored.filter, analysis.analysis, 'update', options.format);
        kind = 'aiUpdate';
      } else if (entry.opportunity) {
        text = formatOpportunityMessage(stored.opportunity, stored.filter, options.format);
        kind = 'basic';
      } else {
        continue;
      }

      await notifier.send(text);
      report.kinds[kind] += 1;
      if (dryRun) {
        report.rendered += 1;
        continue;
      }
      const at = now().toISOString();
      if (entry.opportunity && kind !== 'aiUpdate') store.markNotified(entry.key, at);
      if (analysis && analysisVersion) store.analyses.markNotified(entry.key, analysisVersion, at);
      report.sent += 1;
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
