import type { AppConfig, SourceName } from '../config.js';
import type { OpportunityStore } from '../storage/opportunity-store.js';
import { Freelas99Client } from './99freelas/99freelas-client.js';
import { Freelas99Source } from './99freelas/99freelas-source.js';
import type { OpportunitySource } from './opportunity-source.js';
import { donBrunoProfile } from '../profile/don-bruno.js';
import type { InterestProfile } from '../profile/interest-profile.js';
import { FreelancerClient } from './freelancer/freelancer-client.js';
import { FreelancerSource } from './freelancer/freelancer-source.js';
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
  /** Set when the source cannot run (for example a missing credential); only this source is skipped. */
  disabledReason: string | null;
}

/** Freelancer.com pages read per run (20 projects each), capped further by DISCOVERY_MAX_PAGES. */
export const FREELANCER_MAX_PAGES = 3;
/** Data of these sources may not be used for an alert once it is older than this many hours (API terms: refresh within 24 h). */
export const SOURCE_DATA_MAX_AGE_HOURS: Readonly<Record<string, number>> = { freelancer: 24 };

/** The skill names the profile itself declares as proof of fit; a source may look them up in its own vocabulary. */
export const profileSkillNames = (profile: InterestProfile): string[] => profile.strongSignals.map((rule) => rule.term);

/**
 * Remotive returns every job, with its description, in a single response, so its "details" are read from the
 * stored response and cost no request: only a bound on local work is needed, not the site-friendly budget.
 */
const REMOTIVE_LOCAL_DETAILS_PER_RUN = 500;

export function createSourceRuns(config: AppConfig, store: OpportunityStore, profile: InterestProfile = donBrunoProfile): SourceRun[] {
  return config.sources.map((name): SourceRun => {
    if (name === 'freelancer') {
      if (!config.freelancerToken) {
        return {
          name,
          label: 'Freelancer.com',
          source: { id: 'freelancer', listRecent: async () => ({ items: [], nextCursor: null }), fetchDetail: async () => { throw new Error('disabled'); } },
          limits: { maxPages: 1, targetNew: 1, maxDetailsPerRun: 1 },
          requestCount: () => 0,
          notes: () => [],
          disabledReason: 'FREELANCER_OAUTH_TOKEN is not set in the local .env; only this source is skipped.',
        };
      }
      const client = new FreelancerClient(config.freelancerToken);
      const pages = Math.min(config.discoveryMaxPages, FREELANCER_MAX_PAGES);
      return {
        name,
        label: 'Freelancer.com',
        source: new FreelancerSource({ api: client, cache: store.sourceCache, skillNames: profileSkillNames(profile) }),
        // The listing carries the full projects, so details cost no request in the same run.
        limits: { maxPages: pages, targetNew: config.discoveryTargetNew, maxDetailsPerRun: pages * 20 },
        requestCount: () => client.requestCount,
        notes: () => [],
        disabledReason: null,
      };
    }
    if (name === 'remotive') {
      const source = new RemotiveSource({ cache: store.sourceCache, minIntervalHours: config.remotiveMinIntervalHours });
      return {
        name,
        label: 'Remotive',
        source,
        limits: { maxPages: 1, targetNew: Number.MAX_SAFE_INTEGER, maxDetailsPerRun: REMOTIVE_LOCAL_DETAILS_PER_RUN },
        requestCount: () => source.requestCount,
        disabledReason: null,
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
      disabledReason: null,
    };
  });
}
