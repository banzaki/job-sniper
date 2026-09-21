import type { AppConfig, SourceName } from '../config.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';
import { Freelas99Client } from './99freelas/99freelas-client.js';
import { Freelas99Source } from './99freelas/99freelas-source.js';
import type { OpportunitySource } from './opportunity-source.js';
import { RemotiveSource } from './remotive/remotive-source.js';

/** One enabled source with the limits of ITS OWN run: a source never spends another source's budget. */
export interface SourceRun {
  name: SourceName;
  label: string;
  source: OpportunitySource;
  limits: { maxPages: number; targetNew: number; maxDetailsPerRun: number };
  /** Requests this source made to its site during this process. */
  requestCount(): number;
  /** Extra report lines that only this source has (for example where its data came from). */
  notes(): string[];
}

/**
 * Remotive returns every job, with its description, in a single response, so its "details" are read from the
 * stored response and cost no request: only a bound on local work is needed, not the site-friendly budget.
 */
const REMOTIVE_LOCAL_DETAILS_PER_RUN = 500;

export function createSourceRuns(config: AppConfig, store: OpportunityStore): SourceRun[] {
  return config.sources.map((name): SourceRun => {
    if (name === 'remotive') {
      const source = new RemotiveSource({ cache: store.sourceCache, minIntervalHours: config.remotiveMinIntervalHours });
      return {
        name,
        label: 'Remotive',
        source,
        limits: { maxPages: 1, targetNew: Number.MAX_SAFE_INTEGER, maxDetailsPerRun: REMOTIVE_LOCAL_DETAILS_PER_RUN },
        requestCount: () => source.requestCount,
        notes: () => {
          const load = source.lastLoad;
          const lines = [
            `remotive data source   : ${load.mode}${load.fetchedAt ? ` (downloaded ${load.fetchedAt})` : ''}`,
          ];
          if (load.note) lines.push(`remotive note          : ${load.note}`);
          if (load.nextAttemptAt) lines.push(`remotive next query    : not before ${load.nextAttemptAt}`);
          return lines;
        },
      };
    }
    const client = new Freelas99Client();
    return {
      name,
      label: '99Freelas',
      source: new Freelas99Source(client),
      limits: { maxPages: config.discoveryMaxPages, targetNew: config.discoveryTargetNew, maxDetailsPerRun: config.maxDetailsPerRun },
      requestCount: () => client.requestCount,
      notes: () => [],
    };
  });
}
