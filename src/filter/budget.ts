import type { Opportunity } from '../domain/opportunity.js';

export type UsdBudget =
  /** No amount to judge (no budget, or the source did not say if it is fixed or hourly). */
  | { status: 'none' }
  /** The amounts are in a currency with no reliable rate to USD: nothing is assumed. */
  | { status: 'unconvertible'; currency: string }
  | { status: 'ok'; kind: 'fixed' | 'hourly'; minUsd: number | null; maxUsd: number | null };

/**
 * The budget as an INTERNAL USD equivalent, used only to judge whether a project pays enough. The stored budget keeps
 * its original currency and amounts; nothing here is displayed or written back. The rate is the one the source itself
 * published for that currency (`sourceMetadata.exchangeRateToUsd`, from the official Freelancer.com API); USD needs none.
 * A currency with no such rate is reported as unconvertible, never estimated.
 */
export function budgetInUsd(opportunity: Opportunity): UsdBudget {
  const budget = opportunity.budget;
  if (!budget || (budget.kind !== 'fixed' && budget.kind !== 'hourly') || (budget.min === null && budget.max === null)) return { status: 'none' };
  const currency = budget.currency.trim().toUpperCase();
  if (currency === '') return { status: 'unconvertible', currency: '' };
  const published = opportunity.sourceMetadata.exchangeRateToUsd;
  const rate = currency === 'USD' ? 1 : typeof published === 'number' && Number.isFinite(published) && published > 0 ? published : null;
  if (rate === null) return { status: 'unconvertible', currency };
  return {
    status: 'ok',
    kind: budget.kind,
    minUsd: budget.min === null ? null : budget.min * rate,
    maxUsd: budget.max === null ? null : budget.max * rate,
  };
}

/** A short amount for a reason: one decimal below 10, whole numbers above. */
export function formatUsd(amount: number): string {
  return String(Number(amount.toFixed(amount < 10 ? 1 : 0)));
}
