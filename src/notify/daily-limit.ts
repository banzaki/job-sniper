import type { OpportunityStore } from '../storage/opportunity-store.js';
import { ownerDayWindow } from './day-window.js';

export interface DailyAllowance {
  /** The configured limit of AUTOMATIC alerts per calendar day (America/Sao_Paulo). */
  cap: number;
  /** The calendar day being counted (YYYY-MM-DD). */
  day: string;
  /** Automatic alerts used today: selected by a collection and confirmed by Telegram. Only these count against the limit. */
  automaticToday: number;
  /** How many more automatic alerts may be confirmed today (never negative). */
  remaining: number;
  /** Manual real deliveries confirmed today (notify:manual, backlog sends, alerts older than the queue). They never use the limit. */
  manualDeliveries: number;
  /** Manual previews and demonstrations sent today. They never use the limit and never mark anything as delivered. */
  manualPreviews: number;
}

/**
 * How many AUTOMATIC alerts the personal daily limit still allows at `now`. The limit governs only what collections select
 * and send by themselves; it never blocks the owner from using Telegram by hand (a manual delivery or a preview). The count
 * comes from the delivery records, so it is the same after a restart and turns over at midnight in America/Sao_Paulo.
 */
export function dailyAllowance(store: OpportunityStore, now: Date, cap: number): DailyAllowance {
  const window = ownerDayWindow(now);
  const usage = store.alertQueue.usageBetween(window.start, window.end);
  return { cap, day: window.day, automaticToday: usage.automatic, remaining: Math.max(0, cap - usage.automatic), manualDeliveries: usage.manual, manualPreviews: usage.previews };
}

/** The three kinds of use, kept apart, as one line for a report. */
export const describeDailyAllowance = (allowance: DailyAllowance): string =>
  `today ${allowance.day} (America/Sao_Paulo): automatic alerts ${allowance.automaticToday} of ${allowance.cap} (${allowance.remaining} left) | manual real deliveries ${allowance.manualDeliveries} | manual previews ${allowance.manualPreviews}`;
