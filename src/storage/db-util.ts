import type { DatabaseSync } from 'node:sqlite';

/**
 * Runs `work` in one transaction. "immediate" takes the write lock up front, which makes
 * read-then-write sequences (reserving quota, taking a lock) safe against other processes.
 * Not re-entrant: never call it from inside another transaction.
 */
export function runInTransaction<T>(db: DatabaseSync, work: () => T, mode: 'deferred' | 'immediate' = 'deferred'): T {
  db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
