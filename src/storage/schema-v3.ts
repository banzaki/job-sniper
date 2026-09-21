/**
 * Added in schema version 3. Every statement is idempotent (IF NOT EXISTS) so the migration can be repeated,
 * and none of them touches an existing table.
 */
export const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS discovery_queue (
  source_id           TEXT NOT NULL,
  external_id         TEXT NOT NULL,
  url                 TEXT NOT NULL,
  title               TEXT NOT NULL,
  summary_json        TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'unavailable')),
  first_discovered_at TEXT NOT NULL,
  last_discovered_at  TEXT NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  not_found_count     INTEGER NOT NULL DEFAULT 0,
  last_attempt_at     TEXT,
  next_attempt_at     TEXT,
  last_error          TEXT,
  unavailable_reason  TEXT,
  done_at             TEXT,
  PRIMARY KEY (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_queue_state ON discovery_queue (state, first_discovered_at);

CREATE TABLE IF NOT EXISTS deliveries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK (kind IN ('analysis', 'demo')),
  source_id    TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  ref          TEXT NOT NULL,
  variant      TEXT NOT NULL,
  part_count   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete')),
  created_at   TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (kind, source_id, external_id, ref)
);
CREATE TABLE IF NOT EXISTS delivery_parts (
  delivery_id INTEGER NOT NULL,
  part_no     INTEGER NOT NULL,
  label       TEXT NOT NULL,
  content     TEXT NOT NULL,
  silent      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
  message_id  TEXT,
  sent_at     TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  ambiguous   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (delivery_id, part_no)
);

CREATE TABLE IF NOT EXISTS quota_usage (
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  quota_day  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model, quota_day)
);
CREATE TABLE IF NOT EXISTS quota_state (
  provider                TEXT NOT NULL,
  model                   TEXT NOT NULL,
  tracking_started_at     TEXT NOT NULL,
  cooldown_until          TEXT,
  cooldown_kind           TEXT,
  cooldown_reason         TEXT,
  last_request_started_at TEXT,
  PRIMARY KEY (provider, model)
);
CREATE TABLE IF NOT EXISTS run_locks (
  name        TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
`;
