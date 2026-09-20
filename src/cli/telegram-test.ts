import { ConfigError, loadAppConfig } from '../config.js';
import { TEST_MESSAGE } from '../notify/format-message.js';
import { createNotifier } from '../notify/create-notifier.js';

async function main(): Promise<number> {
  const config = loadAppConfig();
  const notifier = createNotifier(config);

  await notifier.send(TEST_MESSAGE);
  console.log(
    config.dryRun
      ? 'DRY_RUN=true: the test message was printed above and Telegram was NOT called.'
      : 'Telegram confirmed delivery of the test message.',
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : `Telegram test failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  },
);
