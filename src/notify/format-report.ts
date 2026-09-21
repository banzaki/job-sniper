import type { NotifyReport } from './notify-pending.js';

/** Terminal lines for a delivery run. The counts are disjoint: notifications, then the messages inside them. */
export function printNotifyReport(report: NotifyReport, decisions: string, dryRun: boolean): void {
  console.log(
    `notifications (${decisions}): pending=${report.pending} ` +
      `${dryRun ? `rendered=${report.rendered} (dry-run: nothing sent, stored or marked)` : `completed=${report.sent}`} ` +
      `failures=${report.failures.length}`,
  );
  console.log(
    `  kinds: basic=${report.kinds.basic} ai-enriched=${report.kinds.enriched} ai-update=${report.kinds.aiUpdate} ` +
      `| withheld (AI skip)=${report.suppressedBySkip} | withheld (data too old)=${report.staleWithheld}`,
  );
  console.log(
    `  messages: sent=${report.parts.sent} still owed=${report.parts.pending} | incomplete deliveries=${report.incompleteDeliveries}`,
  );
  for (const failure of report.failures) {
    console.error(`  not delivered ${failure.id}${failure.ambiguous ? ' (ambiguous: may have been delivered)' : ''}: ${failure.message}`);
  }
  for (const legacy of report.legacyDeliveries) {
    console.log(
      `  former multi-part delivery ${legacy.id}: ${legacy.partsSent}/${legacy.partsTotal} parts had been sent; ` +
        `not resumed, unsent parts NOT marked as delivered${legacy.held ? '; analysis held (not announced again)' : '; nothing had reached the owner, so it is delivered in the current format'}`,
    );
  }
  if (report.aborted) console.error('  Delivery stopped early; the remaining messages stay pending for the next run.');
}
