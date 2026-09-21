import type { OpportunityKey } from '../domain/opportunity.js';
import type { CandidateProfile } from '../profile/candidate-profile.js';
import type { DeliveryKind, DeliveryRow } from '../storage/delivery-store.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';
import { NotificationError, type Notifier } from './notifier.js';
import { formatOpportunityMessage } from './format-message.js';
import { renderAnalysisMessage, type PresentMode, type RenderedPart } from './present.js';

/**
 * Marks the presentation format a delivery was planned in (compact: one message per opportunity). It is part of
 * the delivery's reference, so a delivery made in an older format (several parts, ref without the marker) is
 * never mistaken for one in the current format, and a new format never re-sends what an old one delivered.
 */
export const PRESENTATION = 'c1';

/** Reference of the real (non-demo) delivery of an analysis in the current format. */
export const analysisDeliveryRef = (analysisVersion: string): string => `${analysisVersion}#${PRESENTATION}`;

export interface DeliveryAttempt {
  partsSent: number;
  partsPending: number;
  complete: boolean;
  failure: { message: string; fatal: boolean; ambiguous: boolean } | null;
}

/**
 * Sends the still-pending parts of a stored delivery, in order, stopping at the first failure. A part is
 * confirmed (with the channel's message id, when given) only after the channel accepted it, and a confirmed
 * part is never sent again, whatever happens to the process. The delivery is complete only when every part is.
 *
 * Ambiguous failures (timeout, lost reply) are recorded on the part and NOT retried in the same run: the
 * message may already have been delivered, so exactly-once cannot be promised. A later run retries it.
 */
export async function sendDeliveryParts(
  store: OpportunityStore,
  notifier: Notifier,
  delivery: DeliveryRow,
  now: () => Date,
): Promise<DeliveryAttempt> {
  const attempt: DeliveryAttempt = { partsSent: 0, partsPending: 0, complete: false, failure: null };

  for (const part of store.deliveries.parts(delivery.id)) {
    if (part.status === 'sent') continue;
    try {
      const result = await notifier.send(part.content, { silent: part.silent });
      store.deliveries.markPartSent(delivery.id, part.partNo, result ? result.messageId : null, now().toISOString());
      attempt.partsSent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const ambiguous = error instanceof NotificationError && error.ambiguous;
      store.deliveries.recordPartFailure(delivery.id, part.partNo, message, ambiguous);
      attempt.failure = { message, fatal: error instanceof NotificationError && error.fatal, ambiguous };
      break;
    }
  }

  attempt.partsPending = store.deliveries.parts(delivery.id).filter((part) => part.status !== 'sent').length;
  attempt.complete = attempt.partsPending === 0 && store.deliveries.complete(delivery.id, now().toISOString());
  return attempt;
}

export interface DemoOptions {
  store: OpportunityStore;
  notifier: Notifier;
  key: OpportunityKey;
  analysisVersion: string;
  /** Names one demonstration; the same label is delivered only once. */
  label: string;
  dryRun: boolean;
  candidate?: CandidateProfile;
  sourceLabels?: Readonly<Record<string, string>>;
  sourceNotes?: Readonly<Record<string, string>>;
  now?: () => Date;
}

export interface DemoReport {
  totalParts: number;
  partsSent: number;
  partsAlreadyConfirmed: number;
  complete: boolean;
  rendered: number;
  failure: DeliveryAttempt['failure'];
}

/**
 * Delivers ONE visual preview of a saved analysis (no AI call). It is a separate delivery of kind "demo": it
 * never touches notified_at of the opportunity or of the analysis, so production flags stay as they were.
 * Repeating the same label sends nothing new. In dry-run the parts are only printed and nothing is stored.
 * An opportunity WITHOUT a saved analysis is previewed with its basic message (filter result and collected data
 * only): no score, suggested price or proposal is ever invented for it.
 */
export async function deliverDemo(options: DemoOptions): Promise<DemoReport> {
  const { store, notifier, key, analysisVersion } = options;
  const now = options.now ?? (() => new Date());

  const stored = store.get(key);
  if (!stored) throw new Error(`No stored opportunity ${key.sourceId}:${key.externalId}.`);
  const analysis = store.analyses.get(key, analysisVersion);

  const render = (): RenderedPart =>
    analysis
      ? renderAnalysisMessage({
          opportunity: stored.opportunity,
          analysis: analysis.analysis,
          mode: 'demo' satisfies PresentMode,
          now: now(),
          ...(options.candidate ? { candidate: options.candidate } : {}),
          ...(options.sourceLabels ? { sourceLabels: options.sourceLabels } : {}),
        })
      : {
          label: 'Mensagem',
          silent: false,
          text: formatOpportunityMessage(stored.opportunity, stored.filter, {
            preview: true,
            now: now(),
            ...(options.sourceLabels ? { sourceLabels: options.sourceLabels } : {}),
            ...(options.sourceNotes ? { sourceNotes: options.sourceNotes } : {}),
          }),
        };

  if (options.dryRun) {
    const message = render();
    await notifier.send(message.text, { silent: message.silent });
    return { totalParts: 1, partsSent: 0, partsAlreadyConfirmed: 0, complete: false, rendered: 1, failure: null };
  }

  const ref = `${analysis ? analysisVersion : 'basic'}#demo-${PRESENTATION}-${options.label}`;
  let delivery = store.deliveries.find('demo' satisfies DeliveryKind, key, ref);
  if (!delivery) {
    const message = render();
    delivery = store.deliveries.create(
      'demo',
      key,
      ref,
      'demo',
      [{ label: message.label, content: message.text, silent: message.silent }],
      now().toISOString(),
    );
  }
  const alreadyConfirmed = store.deliveries.parts(delivery.id).filter((part) => part.status === 'sent').length;
  const attempt = await sendDeliveryParts(store, notifier, delivery, now);
  return {
    totalParts: delivery.partCount,
    partsSent: attempt.partsSent,
    partsAlreadyConfirmed: alreadyConfirmed,
    complete: attempt.complete || delivery.status === 'complete',
    rendered: 0,
    failure: attempt.failure,
  };
}
