import type { DatabaseSync } from 'node:sqlite';

/** Schema version 5 (additive): the last exchange rate to USD a source published for a currency. */
export const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS exchange_rates (
  source_id     TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  rate_to_usd   REAL NOT NULL CHECK (rate_to_usd > 0),
  observed_at   TEXT NOT NULL,
  PRIMARY KEY (source_id, currency_code)
);
`;

export interface ObservedRate {
  rateToUsd: number;
  /** When the source published this rate (ISO). It is valid for a limited time only; the filter decides how long. */
  observedAt: string;
}

/** What the filter needs to convert a budget without asking the source again. */
export interface ExchangeRateLookup {
  lookup(sourceId: string, currencyCode: string): ObservedRate | null;
}

/**
 * The newest rate to USD per source and currency, kept between runs so that an opportunity stored earlier can be
 * converted from a recent observation instead of a new request. Only the rate the source itself published is stored;
 * the original budget of an opportunity is never touched.
 */
export class ExchangeRateStore implements ExchangeRateLookup {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  lookup(sourceId: string, currencyCode: string): ObservedRate | null {
    const row = this.db
      .prepare('SELECT rate_to_usd, observed_at FROM exchange_rates WHERE source_id = ? AND currency_code = ?')
      .get(sourceId, currencyCode.trim().toUpperCase());
    if (!row) return null;
    const rate = row.rate_to_usd;
    const at = row.observed_at;
    return typeof rate === 'number' && typeof at === 'string' ? { rateToUsd: rate, observedAt: at } : null;
  }

  /** Keeps the newest observation: an older one never replaces it. Ignores an unusable rate or date. */
  record(sourceId: string, currencyCode: string, rateToUsd: number, observedAt: string): void {
    const code = currencyCode.trim().toUpperCase();
    if (code === '' || !Number.isFinite(rateToUsd) || rateToUsd <= 0 || Number.isNaN(Date.parse(observedAt))) return;
    this.db
      .prepare(
        `INSERT INTO exchange_rates (source_id, currency_code, rate_to_usd, observed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (source_id, currency_code) DO UPDATE SET
           rate_to_usd = excluded.rate_to_usd, observed_at = excluded.observed_at
         WHERE excluded.observed_at >= exchange_rates.observed_at`,
      )
      .run(sourceId, code, rateToUsd, observedAt);
  }

  /**
   * One-time, local: registers the rates already saved inside stored opportunities (each one dated by its own
   * collection time). No request is made. Returns how many currencies were registered.
   */
  seedFromOpportunities(): number {
    const rows = this.db
      .prepare(
        `SELECT source_id,
                json_extract(payload_json, '$.budget.currency') AS currency,
                json_extract(payload_json, '$.sourceMetadata.exchangeRateToUsd') AS rate,
                json_extract(payload_json, '$.fetchedAt') AS observed_at
         FROM opportunities
         WHERE json_extract(payload_json, '$.sourceMetadata.exchangeRateToUsd') IS NOT NULL
         ORDER BY observed_at ASC`,
      )
      .all();
    for (const row of rows) {
      if (typeof row.currency === 'string' && typeof row.rate === 'number' && typeof row.observed_at === 'string') {
        this.record(String(row.source_id), row.currency, row.rate, row.observed_at);
      }
    }
    return (this.db.prepare('SELECT COUNT(*) AS n FROM exchange_rates').get()?.n as number | undefined) ?? 0;
  }
}
