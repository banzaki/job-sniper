import type { FilterDecision } from '../domain/filter-result.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import type { CandidateProfile } from '../profile/candidate-profile.js';
import type { DeliveryRow } from '../storage/delivery-store.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';
import { analysisDeliveryRef, sendDeliveryParts, type DeliveryAttempt } from './deliver.js';
import { formatOpportunityMessage, type FormatOptions } from './format-message.js';
import { NotificationError, type Notifier } from './notifier.js';
import { renderAnalysisMessage } from './present.js';

export interface NotifyOptions {
  store: OpportunityStore;
  notifier: Notifier;
  decisions: readonly FilterDecision[];
  /** In dry-run nothing is sent, stored or marked, whatever the notifier does. */
  dryRun: boolean;
  /** Analysis version whose results may be announced. Omit to ignore AI analyses entirely. */
  analysisVersion?: string;
  /** When given, only these opportunities are considered; everything else stays untouched. */
  only?: readonly OpportunityKey[];
  /** Only to recognize known skill names when showing the verification. */
  candidate?: CandidateProfile;
  format?: FormatOptions;
  now?: () => Date;
}

export interface NotifyReport {
  /** Notifications owed at the start: incomplete deliveries plus new ones. */
  pending: number;
  /** Notifications fully confirmed by the channel and marked (basic messages, or analyses with every part sent). */
  sent: number;
  /** Dry-run only: notifications rendered but not sent. */
  rendered: number;
  /** Of the notifications sent (or rendered): basic filter message, AI-enriched first message, AI update. */
  kinds: { basic: number; enriched: number; aiUpdate: number };
  /** Individual messages confirmed in this run, and messages still owed afterwards (one per notification). */
  parts: { sent: number; pending: number };
  /**
   * Deliveries planned in the former multi-part format that never completed. They are NOT resumed (their unsent
   * detail parts are dropped by decision) and their unsent parts are never marked as delivered. When at least
   * one part reached the owner, the analysis is also not announced again ("held"); otherwise nothing reached
   * the owner and it is delivered in the current format.
   */
  legacyDeliveries: { id: string; partsSent: number; partsTotal: number; held: boolean }[];
  /** Deliveries left incomplete (some part unconfirmed); the next run resumes them. */
  incompleteDeliveries: number;
  /** Basic notifications withheld because the AI judged the opportunity a clear skip. */
  suppressedBySkip: number;
  failures: { id: string; message: string; ambiguous: boolean }[];
  /** Set when a failure made further sending pointless; remaining items stay pending. */
  aborted: string | null;
}

interface Pending {
  key: OpportunityKey;
  /** The first (deterministic-filter) notification is still owed. */
  opportunity: boolean;
  /** An AI analysis result has never been fully announced. */
  analysis: boolean;
}

const idOf = (key: OpportunityKey): string => `${key.sourceId}:${key.externalId}`;

/**
 * Sends what is owed, from everything in the database (not only what this run discovered). Two independent
 * states are tracked: opportunities.notified_at (first notification) and analyses.notified_at (the AI result).
 *   both owed          -> one AI-enriched delivery, marks both when complete;
 *   only analysis owed -> an "análise atualizada" delivery (opportunity already notified, or filtered out);
 *   only first owed    -> the basic message (no analysis yet, or AI unavailable).
 * An AI analysis is delivered as ONE compact message, stored before sending. Deliveries with several parts (the
 * former format) are never resumed. The flags are written only after EVERY part of a delivery is confirmed.
 * A clear AI skip is never announced and withholds the basic message. Nothing is written in dry-run.
 */
export async function notifyPending(options: NotifyOptions): Promise<NotifyReport> {
  const { store, notifier, decisions, dryRun, analysisVersion } = options;
  const now = options.now ?? (() => new Date());
  const report: NotifyReport = {
    pending: 0,
    sent: 0,
    rendered: 0,
    kinds: { basic: 0, enriched: 0, aiUpdate: 0 },
    parts: { sent: 0, pending: 0 },
    legacyDeliveries: [],
    incompleteDeliveries: 0,
    suppressedBySkip: 0,
    failures: [],
    aborted: null,
  };
  const allowed = options.only ? new Set(options.only.map(idOf)) : null;
  const wanted = (key: OpportunityKey): boolean => allowed === null || allowed.has(idOf(key));

  const handled = new Set<string>();

  const conclude = (delivery: DeliveryRow, attempt: DeliveryAttempt): boolean => {
    report.parts.sent += attempt.partsSent;
    report.parts.pending += attempt.partsPending;
    if (attempt.complete) {
      applyCompletion(store, delivery, now().toISOString());
      report.sent += 1;
      report.kinds[delivery.variant === 'enriched' ? 'enriched' : 'aiUpdate'] += 1;
    } else {
      report.incompleteDeliveries += 1;
    }
    if (attempt.failure) {
      report.failures.push({ id: idOf(delivery.key), message: attempt.failure.message, ambiguous: attempt.failure.ambiguous });
      if (attempt.failure.fatal) {
        report.aborted = attempt.failure.message;
        return false;
      }
    }
    return true;
  };

  // 1. Deliveries interrupted earlier. Current-format ones resume (only what is missing is sent); former
  //    multi-part ones are reported and left alone: nothing is resumed, re-sent or marked as delivered.
  const held = new Set<string>();
  if (analysisVersion) {
    const currentRef = analysisDeliveryRef(analysisVersion);
    for (const delivery of store.deliveries.listIncomplete('analysis')) {
      if (!wanted(delivery.key)) continue;
      if (delivery.ref === analysisVersion) {
        const parts = store.deliveries.parts(delivery.id);
        const partsSent = parts.filter((part) => part.status === 'sent').length;
        report.legacyDeliveries.push({ id: idOf(delivery.key), partsSent, partsTotal: parts.length, held: partsSent > 0 });
        if (partsSent > 0) held.add(idOf(delivery.key));
        continue;
      }
      if (dryRun || delivery.ref !== currentRef) continue;
      report.pending += 1;
      handled.add(idOf(delivery.key));
      if (!conclude(delivery, await sendDeliveryParts(store, notifier, delivery, now))) return report;
    }
  }

  // 2. What is newly owed.
  const pending = new Map<string, Pending>();
  const add = (key: OpportunityKey, field: 'opportunity' | 'analysis'): void => {
    const entry = pending.get(idOf(key)) ?? { key, opportunity: false, analysis: false };
    entry[field] = true;
    pending.set(idOf(key), entry);
  };
  for (const key of store.listPendingNotification(decisions, analysisVersion)) add(key, 'opportunity');
  if (analysisVersion) {
    for (const key of store.analyses.listPendingNotification(analysisVersion)) add(key, 'analysis');
    report.suppressedBySkip =
      store.listPendingNotification(decisions).length - store.listPendingNotification(decisions, analysisVersion).length;
  }

  for (const [id, entry] of pending) {
    if (!wanted(entry.key) || handled.has(id) || held.has(id)) continue;
    report.pending += 1;
    try {
      const stored = store.get(entry.key);
      if (!stored) continue;
      const analysis = analysisVersion && entry.analysis ? store.analyses.get(entry.key, analysisVersion) : null;

      if (analysis && analysisVersion) {
        const variant = entry.opportunity ? 'enriched' : 'update';
        const kind = variant === 'enriched' ? 'enriched' : 'aiUpdate';
        const message = renderAnalysisMessage({
          opportunity: stored.opportunity,
          analysis: analysis.analysis,
          mode: variant === 'enriched' ? 'enriched' : 'update',
          now: now(),
          ...(options.candidate ? { candidate: options.candidate } : {}),
          ...(options.format?.sourceLabels ? { sourceLabels: options.format.sourceLabels } : {}),
        });

        if (dryRun) {
          await notifier.send(message.text, { silent: message.silent });
          report.rendered += 1;
          report.kinds[kind] += 1;
          continue;
        }

        const ref = analysisDeliveryRef(analysisVersion);
        let delivery = store.deliveries.find('analysis', entry.key, ref);
        if (delivery?.status === 'complete') {
          // Everything was confirmed earlier; only the flags were missing (crash between the two steps).
          applyCompletion(store, delivery, now().toISOString());
          continue;
        }
        delivery ??= store.deliveries.create(
          'analysis',
          entry.key,
          ref,
          variant,
          [{ label: message.label, content: message.text, silent: message.silent }],
          now().toISOString(),
        );
        if (!conclude(delivery, await sendDeliveryParts(store, notifier, delivery, now))) return report;
        continue;
      }

      if (entry.opportunity) {
        await notifier.send(formatOpportunityMessage(stored.opportunity, stored.filter, options.format));
        report.kinds.basic += 1;
        if (dryRun) {
          report.rendered += 1;
          continue;
        }
        store.markNotified(entry.key, now().toISOString());
        report.sent += 1;
        report.parts.sent += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failures.push({ id, message, ambiguous: error instanceof NotificationError && error.ambiguous });
      if (error instanceof NotificationError && error.fatal) {
        report.aborted = message;
        break;
      }
    }
  }

  return report;
}

/** Writes the production flags once a delivery is complete: the analysis, and the opportunity for a first notice. */
function applyCompletion(store: OpportunityStore, delivery: DeliveryRow, at: string): void {
  if (delivery.kind !== 'analysis') return;
  if (delivery.variant === 'enriched') store.markNotified(delivery.key, at);
  store.analyses.markNotified(delivery.key, delivery.ref.split('#')[0] ?? delivery.ref, at);
}
