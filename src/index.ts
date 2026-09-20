import type { Opportunity } from './domain/opportunity.js';
import { Freelas99Source } from './sources/99freelas/99freelas-source.js';
import { SourceBlockedError } from './sources/source-errors.js';

const MAX_DETAILS = 3;
const DESCRIPTION_PREVIEW_LENGTH = 200;

async function main(): Promise<void> {
  const source = new Freelas99Source();

  const summaries = await source.listRecent();
  console.log(`[${source.id}] listRecent: ${summaries.length} opportunities found`);

  for (const summary of summaries.slice(0, MAX_DETAILS)) {
    const opportunity = await source.fetchDetail(summary.externalId);
    printOpportunity(opportunity);
  }
}

function printOpportunity(op: Opportunity): void {
  console.log('');
  console.log(`- externalId : ${op.externalId}`);
  console.log(`  title      : ${op.title}`);
  console.log(`  status     : ${op.status}`);
  console.log(`  category   : ${op.category ?? 'n/a'} / ${op.subcategory ?? 'n/a'}`);
  console.log(`  budget     : ${formatBudget(op.budget)}`);
  console.log(`  proposals  : ${op.proposalCount ?? 'n/a'}`);
  console.log(`  interested : ${op.interestedCount ?? 'n/a'}`);
  console.log(`  url        : ${op.url}`);
  console.log(`  description: ${preview(op.description)}`);
}

function formatBudget(budget: Opportunity['budget']): string {
  if (!budget) return 'n/a';
  if (budget.min === null && budget.max === null) return budget.kind;
  return `${budget.kind} ${budget.currency} ${budget.min ?? '?'}-${budget.max ?? '?'}`;
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DESCRIPTION_PREVIEW_LENGTH
    ? `${flat.slice(0, DESCRIPTION_PREVIEW_LENGTH).trimEnd()}…`
    : flat;
}

main().catch((error: unknown) => {
  if (error instanceof SourceBlockedError) {
    console.error(`Blocked by the source, stopping without retry: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
