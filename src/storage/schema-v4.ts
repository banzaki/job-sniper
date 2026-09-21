/**
 * Schema version 4 (additive, idempotent): a persistent cache and attempt clock for sources that publish a whole
 * feed in one response. Nothing here touches existing tables or rows.
 */
export const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS source_cache (
  source_id            TEXT PRIMARY KEY,
  payload_json         TEXT,
  fetched_at           TEXT,
  last_attempt_at      TEXT,
  next_attempt_at      TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT
);
`;
