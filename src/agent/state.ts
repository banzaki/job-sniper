import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The Hunter's own small files, next to the database (never inside it, so the database schema is untouched):
 *   <db>.hunter.lock   exists while a hunt or a release runs (one at a time)
 *   <db>.hunter.json   what the Hunter did last: the last hunt, the last error and the scheduled slots already started
 */
export interface HunterFiles {
  lock: string;
  state: string;
  log: string;
}

export const hunterFiles = (databasePath: string): HunterFiles => ({
  lock: `${databasePath}.hunter.lock`,
  state: `${databasePath}.hunter.json`,
  log: join(dirname(databasePath), 'hunter.log'),
});

export interface HuntRecord {
  startedAt: string;
  finishedAt: string;
  /** "all", "freelancer" or "99freelas". */
  source: string;
  trigger: 'manual' | 'schedule';
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** A short line naming what failed. Never a secret. */
  error: string | null;
}

export interface SlotRecord {
  startedAt: string;
  status: 'started' | 'done' | 'failed';
}

export interface HunterState {
  lastHunt: HuntRecord | null;
  lastError: { at: string; message: string } | null;
  /** Scheduled slots ("YYYY-MM-DD@HH:MM") whose run was ever started: a slot is never run twice, whatever happens to the process. */
  slots: Record<string, SlotRecord>;
}

export const emptyState = (): HunterState => ({ lastHunt: null, lastError: null, slots: {} });

export function readState(path: string): HunterState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HunterState>;
    return { lastHunt: parsed.lastHunt ?? null, lastError: parsed.lastError ?? null, slots: parsed.slots ?? {} };
  } catch {
    return emptyState();
  }
}

/** Written to a temporary file first and renamed, so a crash never leaves half a state. */
export function writeState(path: string, state: HunterState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

// ---------- the lock ----------
export interface LockInfo {
  pid: number;
  startedAt: string;
  purpose: string;
}

/** A run that takes longer than this is considered dead, whatever its process says. */
export const LOCK_MAX_AGE_MS = 30 * 60_000;

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export type LockResult = { acquired: true; release: () => void } | { acquired: false; heldBy: LockInfo | null };

/**
 * Takes the lock atomically (the file is created only if it does not exist). A lock left by a dead process, or older than
 * LOCK_MAX_AGE_MS, is reclaimed. Two hunts, or a hunt and a release, can never run at the same time.
 */
export function acquireLock(path: string, purpose: string, now: Date, alive: (pid: number) => boolean = isProcessAlive): LockResult {
  mkdirSync(dirname(path), { recursive: true });
  const info: LockInfo = { pid: process.pid, startedAt: now.toISOString(), purpose };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify(info));
      closeSync(fd);
      return {
        acquired: true,
        release: () => {
          try {
            if (existsSync(path) && (JSON.parse(readFileSync(path, 'utf8')) as LockInfo).pid === process.pid) unlinkSync(path);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let held: LockInfo | null = null;
      try {
        held = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
      } catch {
        held = null;
      }
      const stale = held === null || !alive(held.pid) || now.getTime() - Date.parse(held.startedAt) > LOCK_MAX_AGE_MS;
      if (!stale) return { acquired: false, heldBy: held };
      try {
        unlinkSync(path);
      } catch {
        /* someone else reclaimed it first: the next attempt decides */
      }
    }
  }
  return { acquired: false, heldBy: null };
}
