import { randomUUID } from 'node:crypto';
import type { FilterDecision } from '../domain/filter-result.js';
import type { OpportunityKey } from '../domain/opportunity.js';
import type { CandidateProfile } from '../profile/candidate-profile.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';
import { dailyAllowance, type DailyAllowance } from './daily-limit.js';
import { sendDeliveryParts, type DeliveryAttempt } from './deliver.js';
import { formatOpportunityMessage, type FormatOptions } from './format-message.js';
import { safeHttpUrl } from './html.js';
import { ConsoleNotifier, type Notifier } from './notifier.js';
import { notifyPending, type NotifyReport } from './notify-pending.js';
import { renderAnalysisMessage, type RenderedPart } from './present.js';

/**
 * The owner's own use of Telegram, apart from the automatic alerts of the collections. The personal daily limit
 * (MAX_TELEGRAM_ALERTS_PER_DAY) governs ONLY automatic alerts; neither path here consumes it.
 *
 *   previewManual  a "🧪 PRÉVIA MANUAL" of ONE stored opportunity, as often as wanted. It is a delivery of kind demo: it never
 *                  changes notified_at, the alert queue or any production delivery, and never calls an AI.
 *   deliverManual  the REAL delivery of ONE opportunity that was never delivered, ignoring only the automatic daily limit. It
 *                  still requires a deliverable decision, a valid link, real content and (when sending) Telegram credentials,
 *                  fresh data, and it writes notified_at only after Telegram confirms.
 */

const idOf = (key: OpportunityKey): string => `${key.sourceId}:${key.externalId}`;

interface CommonOptions {
  store: OpportunityStore;
  /** Used only when `send` is true. Without --send nothing is sent, so a notifier is never needed. */
  notifier: Notifier;
  key: OpportunityKey;
  /** True only when the owner asked to send (--send). Otherwise the message is only rendered (through `print`) and nothing is stored. */
  send: boolean;
  analysisVersion?: string;
  candidate?: CandidateProfile;
  format?: FormatOptions;
  /** Receives the rendered text when not sending. */
  print?: (text: string) => void;
  now?: () => Date;
}

// ---------- preview ----------
export interface ManualPreviewOptions extends CommonOptions {
  /** Hours after which the source's data is older than its terms allow for an alert; a preview only WARNS about it. */
  maxAgeHoursBySource?: Readonly<Record<string, number>>;
}

export interface ManualPreviewReport {
  rendered: string;
  /** True when the preview was confirmed by Telegram. */
  sent: boolean;
  /** The data is older than its source allows for an alert: shown as a warning, the preview is still allowed. */
  staleData: boolean;
  failure: DeliveryAttempt['failure'];
}

/** The decision of the stored opportunity is what the basic message shows; an analysis, when saved, is shown instead. */
export async function previewManual(options: ManualPreviewOptions): Promise<ManualPreviewReport> {
  const { store, key } = options;
  const now = options.now ?? (() => new Date());
  const stored = store.get(key);
  if (!stored) throw new Error(`No stored opportunity ${idOf(key)}.`);
  const analysis = options.analysisVersion ? store.analyses.get(key, options.analysisVersion) : null;

  const message: RenderedPart = analysis
    ? renderAnalysisMessage({
        opportunity: stored.opportunity,
        analysis: analysis.analysis,
        mode: 'manual_preview',
        now: now(),
        ...(options.candidate ? { candidate: options.candidate } : {}),
        ...(options.format?.sourceLabels ? { sourceLabels: options.format.sourceLabels } : {}),
      })
    : {
        label: 'Mensagem',
        silent: false,
        text: formatOpportunityMessage(stored.opportunity, stored.filter, { rates: store.exchangeRates, ...options.format, kind: 'manual_preview', now: now() }),
      };

  const maxAge = options.maxAgeHoursBySource?.[stored.opportunity.sourceId];
  const staleData = maxAge !== undefined && !(now().getTime() - Date.parse(stored.opportunity.fetchedAt) <= maxAge * 3_600_000);
  const report: ManualPreviewReport = { rendered: message.text, sent: false, staleData, failure: null };

  if (!options.send) {
    options.print?.(message.text);
    return report;
  }
  // Every preview is its own delivery (a unique ref), so it can be repeated any number of times and never touches a production one.
  const delivery = store.deliveries.create('demo', key, `manual-preview#${now().toISOString()}-${randomUUID().slice(0, 8)}`, 'demo', [{ label: message.label, content: message.text, silent: message.silent }], now().toISOString());
  const attempt = await sendDeliveryParts(store, options.notifier, delivery, now);
  report.sent = attempt.complete;
  report.failure = attempt.failure;
  return report;
}

// ---------- real manual delivery ----------
export interface ManualDeliveryOptions extends CommonOptions {
  /** The decisions that may be delivered (a skip never is). */
  decisions: readonly FilterDecision[];
  maxAgeHoursBySource?: Readonly<Record<string, number>>;
  /** Only to REPORT how the automatic limit stands; it is never applied here. */
  dailyCap?: number;
}

export type ManualOutcome = 'sent' | 'rendered' | 'refused' | 'failed';

export interface ManualDeliveryReport {
  outcome: ManualOutcome;
  /** Why it was refused or failed, in words for the owner. */
  reason: string | null;
  notify: NotifyReport | null;
  /** The automatic limit and the manual counters after this command, when a cap was given. */
  daily: DailyAllowance | null;
}

/** The REAL delivery of one opportunity. Ignores only the automatic daily limit; every other rule still applies. */
export async function deliverManual(options: ManualDeliveryOptions): Promise<ManualDeliveryReport> {
  const { store, key } = options;
  const now = options.now ?? (() => new Date());
  const finish = (outcome: ManualOutcome, reason: string | null, notify: NotifyReport | null): ManualDeliveryReport => ({
    outcome,
    reason,
    notify,
    daily: options.dailyCap === undefined ? null : dailyAllowance(store, now(), options.dailyCap),
  });
  const refuse = (reason: string): ManualDeliveryReport => finish('refused', reason, null);

  const stored = store.get(key);
  if (!stored) return refuse(`No stored opportunity ${idOf(key)}.`);
  if (stored.notifiedAt !== null) {
    return refuse(`${idOf(key)} was already delivered (${stored.notifiedAt}); it is not sent again as a new alert. To see it again use: npm run notify:preview -- --only ${idOf(key)} --send`);
  }
  if (!options.decisions.includes(stored.filter.decision)) {
    return refuse(`${idOf(key)} is "${stored.filter.decision}", which is not deliverable as an alert (allowed: ${options.decisions.join(', ') || 'none'}). Use notify:preview to look at it.`);
  }
  if (safeHttpUrl(stored.opportunity.url) === null) return refuse(`${idOf(key)} has no valid http(s) link, so it is not delivered.`);
  if (stored.opportunity.title.trim() === '') return refuse(`${idOf(key)} has no title, so it is not delivered.`);
  const maxAge = options.maxAgeHoursBySource?.[stored.opportunity.sourceId];
  if (maxAge !== undefined && !(now().getTime() - Date.parse(stored.opportunity.fetchedAt) <= maxAge * 3_600_000)) {
    return refuse(`The collected data of ${idOf(key)} is older than ${maxAge} hours, which its source's terms allow for an alert. Collect again first (or use notify:preview).`);
  }

  const report = await notifyPending({
    store,
    // Without --send the message can only be printed: a real notifier is never used, whatever was passed.
    notifier: options.send ? options.notifier : new ConsoleNotifier(),
    decisions: options.decisions,
    dryRun: !options.send,
    ...(options.analysisVersion ? { analysisVersion: options.analysisVersion } : {}),
    ...(options.candidate ? { candidate: options.candidate } : {}),
    ...(options.format ? { format: options.format } : {}),
    ...(options.maxAgeHoursBySource ? { maxAgeHoursBySource: options.maxAgeHoursBySource } : {}),
    only: [key],
    alertKeys: [key],
    maxAlerts: 1,
    now,
  });

  if (!options.send) return finish('rendered', null, report);
  if (report.failures.length > 0) return finish('failed', report.failures.map((failure) => failure.message).join('; '), report);
  if (store.get(key)?.notifiedAt === null || report.sent === 0) {
    return finish('failed', report.suppressedBySkip > 0 ? 'The AI analysis judged this a clear skip, so no alert is sent.' : 'Nothing was delivered.', report);
  }
  // It was chosen by the owner, not by a collection: it stays out of the automatic count even if a collection had selected it.
  store.alertQueue.markManual(key);
  return finish('sent', null, report);
}
