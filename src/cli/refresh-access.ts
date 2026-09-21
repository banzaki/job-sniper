import { ConfigError, loadAppConfig } from '../config.js';
import type { Opportunity, OpportunityKey } from '../domain/opportunity.js';
import { Freelas99Client } from '../sources/99freelas/99freelas-client.js';
import { Freelas99Source } from '../sources/99freelas/99freelas-source.js';
import type { OpportunitySource } from '../sources/opportunity-source.js';
import { SourceBlockedError } from '../sources/source-errors.js';
import { OpportunityStore } from '../storage/opportunity-store.js';

const USAGE = 'Usage: npm run access:refresh -- --id <sourceId:externalId>';

/** Sources this command can query; the only place that knows a concrete source. */
const SOURCES: Record<string, (client: Freelas99Client) => OpportunitySource> = {
  '99freelas': (client) => new Freelas99Source(client),
};

function parseKey(argv: readonly string[]): OpportunityKey {
  if (argv.length !== 2 || argv[0] !== '--id') throw new ConfigError(USAGE);
  const raw = argv[1] ?? '';
  const separator = raw.indexOf(':');
  if (separator < 1 || separator === raw.length - 1) throw new ConfigError(USAGE);
  return { sourceId: raw.slice(0, separator), externalId: raw.slice(separator + 1) };
}

const describe = (access: Opportunity['access']): string =>
  `kind=${access.kind} publicAt=${access.publicAt ?? 'null'} rawLabel=${access.rawLabel ? `"${access.rawLabel}"` : 'null'}`;

/**
 * Re-reads ONE opportunity's detail page (a single sequential request) and updates only its access
 * information. Availability is taken from what the page shows now, never from a time having passed.
 * Nothing else in the stored opportunity changes.
 */
async function main(): Promise<number> {
  const key = parseKey(process.argv.slice(2));
  const config = loadAppConfig();
  const client = new Freelas99Client();
  const sourceFactory = SOURCES[key.sourceId];
  if (!sourceFactory) throw new ConfigError(`No source is available for "${key.sourceId}". ${USAGE}`);

  const store = new OpportunityStore(config.databasePath);
  try {
    const stored = store.get(key);
    if (!stored) throw new ConfigError(`${key.sourceId}:${key.externalId} is not in the database.`);

    let fresh: Opportunity;
    try {
      fresh = await sourceFactory(client).fetchDetail(key.externalId);
    } catch (error) {
      if (error instanceof SourceBlockedError) {
        console.error(`Blocked by the source, stopping without retry: ${error.message}`);
        return 2;
      }
      throw error;
    }

    console.log(`http requests: ${client.requestCount}`);
    console.log(`before : ${describe(stored.opportunity.access)}`);
    console.log(`after  : ${describe(fresh.access)}`);
    if (fresh.status !== stored.opportunity.status) {
      console.log(`note   : the source now reports status "${fresh.status}" (stored: "${stored.opportunity.status}"); status was NOT changed by this command`);
    }
    store.updateAccess(key, fresh.access, fresh.fetchedAt);
    console.log(`updated access for ${key.sourceId}:${key.externalId} (checked at ${fresh.fetchedAt}); nothing else was modified`);
    return 0;
  } finally {
    store.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
