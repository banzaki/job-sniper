import type { Opportunity } from '../domain/opportunity.js';
import type { ExchangeRateLookup } from '../storage/exchange-rate-store.js';

/** A published exchange rate is only trusted for this long after the source observed it. */
export const EXCHANGE_RATE_MAX_AGE_HOURS = 24;

export type UsdBudget =
  /** No amount to judge (no budget, or the source did not say if it is fixed or hourly). */
  | { status: 'none' }
  /** The amounts are in a currency with no fresh rate to USD: nothing is assumed. */
  | { status: 'unconvertible'; currency: string }
  | { status: 'ok'; kind: 'fixed' | 'hourly'; minUsd: number | null; maxUsd: number | null };

const isFresh = (observedAt: string, now: Date): boolean => {
  const at = Date.parse(observedAt);
  return !Number.isNaN(at) && now.getTime() - at <= EXCHANGE_RATE_MAX_AGE_HOURS * 3_600_000;
};

/** The rate the opportunity itself carries (published by its source when it was collected), with its date. */
export function ownRate(opportunity: Opportunity): { currency: string; rateToUsd: number; observedAt: string } | null {
  const rate = opportunity.sourceMetadata.exchangeRateToUsd;
  const currency = opportunity.budget?.currency.trim().toUpperCase() ?? '';
  if (currency === '' || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
  return { currency, rateToUsd: rate, observedAt: opportunity.fetchedAt };
}

/**
 * The budget as an INTERNAL USD equivalent, used only to judge it against the floors. The stored budget keeps its
 * original currency and amounts; nothing here is displayed or written back. USD needs no rate. Any other currency uses,
 * in this order, the rate the opportunity itself carries or the newest rate its source published for that currency
 * (the shared cache), and only when observed within 24 hours of `now`. Without one the budget is unconvertible: it
 * is never estimated, and the opportunity is not removed for it.
 */
export function budgetInUsd(opportunity: Opportunity, now: Date, rates?: ExchangeRateLookup): UsdBudget {
  const budget = opportunity.budget;
  if (!budget || (budget.kind !== 'fixed' && budget.kind !== 'hourly') || (budget.min === null && budget.max === null)) return { status: 'none' };
  const currency = budget.currency.trim().toUpperCase();
  if (currency === '') return { status: 'unconvertible', currency: '' };

  let rate: number | null = currency === 'USD' ? 1 : null;
  if (rate === null) {
    const own = ownRate(opportunity);
    if (own && isFresh(own.observedAt, now)) rate = own.rateToUsd;
  }
  if (rate === null) {
    const cached = rates?.lookup(opportunity.sourceId, currency);
    if (cached && isFresh(cached.observedAt, now)) rate = cached.rateToUsd;
  }
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
