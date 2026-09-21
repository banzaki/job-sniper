import type { Opportunity } from '../domain/opportunity.js';
import { budgetInUsd, freshRate } from '../filter/budget.js';
import type { ExchangeRateLookup } from '../storage/exchange-rate-store.js';
import { formatMoney } from './present.js';

export interface BudgetDisplayOptions {
  /** The currency to show first, when a fresh rate is stored (a 3-letter code, default USD). */
  displayCurrency?: string;
  /** The rates a source itself published and the database kept. No external service is ever consulted. */
  rates?: ExchangeRateLookup;
  now: Date;
}

export interface BudgetDisplay {
  /** The budget line: the converted value with "≈" when a fresh rate exists, otherwise the original. */
  value: string;
  /** The original budget and currency, shown below the conversion; null when there is no conversion to show. */
  original: string | null;
}

/** A whole number is enough for a conversion; a value that would round to zero keeps one decimal. */
function roundedPair(min: number | null, max: number | null): [number | null, number | null] {
  const whole = (value: number | null): number | null => (value === null ? null : Math.round(value));
  const [a, b] = [whole(min), whole(max)];
  if ((a ?? 1) === 0 && (b ?? 1) === 0) return [min === null ? null : Math.round(min * 10) / 10, max === null ? null : Math.round(max * 10) / 10];
  return [a, b];
}

/**
 * The budget of a project for the Telegram alert, in the preferred currency. With a fresh rate the converted value comes first,
 * marked with "≈", and the original budget is shown below it; with the original already in that currency there is one line
 * only; with no fresh rate the original is shown alone. Fixed or hourly is kept ("/h"), the original amounts are never
 * touched, and only rates the source published and the database stored are used (24 hours).
 */
export function displayBudget(opportunity: Opportunity, options: BudgetDisplayOptions): BudgetDisplay {
  const budget = opportunity.budget;
  if (!budget || budget.kind === 'unknown') return { value: 'não informado', original: null };
  if (budget.min === null && budget.max === null) return { value: budget.kind === 'open' ? 'em aberto (sem valor informado)' : 'não informado', original: null };

  const suffix = budget.kind === 'hourly' ? '/h' : '';
  const original = `${formatMoney(budget.currency || 'BRL', budget.min, budget.max)}${suffix}`;
  const display = (options.displayCurrency ?? 'USD').trim().toUpperCase();
  const currency = budget.currency.trim().toUpperCase();
  if (currency === '' || currency === display || (budget.kind !== 'fixed' && budget.kind !== 'hourly')) return { value: original, original: null };

  const usd = budgetInUsd(opportunity, options.now, options.rates);
  if (usd.status !== 'ok') return { value: original, original: null };
  let factor = 1;
  if (display !== 'USD') {
    const rate = freshRate(options.rates, opportunity.sourceId, display, options.now);
    if (rate === null) return { value: original, original: null };
    factor = 1 / rate;
  }
  const [min, max] = roundedPair(usd.minUsd === null ? null : usd.minUsd * factor, usd.maxUsd === null ? null : usd.maxUsd * factor);
  return { value: `≈ ${formatMoney(display, min, max)}${suffix}`, original };
}
