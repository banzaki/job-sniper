export interface AppConfig {
  databasePath: string;
  maxDetailsPerRun: number;
}

export const DEFAULT_DATABASE_PATH = './data/job-sniper.db';
export const DEFAULT_MAX_DETAILS_PER_RUN = 10;

/** Reads settings from the environment, falling back to safe defaults and warning on bad values. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): AppConfig {
  const databasePath = env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;

  let maxDetailsPerRun = DEFAULT_MAX_DETAILS_PER_RUN;
  const rawMax = env.MAX_DETAILS_PER_RUN?.trim();
  if (rawMax) {
    const parsed = Number(rawMax);
    if (Number.isInteger(parsed) && parsed >= 1) {
      maxDetailsPerRun = parsed;
    } else {
      warn(
        `Ignoring invalid MAX_DETAILS_PER_RUN="${rawMax}"; using ${DEFAULT_MAX_DETAILS_PER_RUN}.`,
      );
    }
  }

  return { databasePath, maxDetailsPerRun };
}
