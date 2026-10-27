-- 0.5.0 (C373c): the workspace DEFAULT MODE for calls that match no rule: permissive (allow), verification (hold for the
-- owner) or closed (refuse). A fresh install and an upgraded 0.3.2/0.4.x install both start PERMISSIVE: no behaviour change.
-- `mode_changes` records every change (who, when, from -> to). Additive only; no existing row changes; no down migration.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER,
  updated_by TEXT,
  CHECK (key <> 'default_mode' OR value IN ('permissive', 'verification', 'closed'))
);
INSERT INTO settings (key, value) VALUES ('default_mode', 'permissive');
CREATE TABLE mode_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  from_mode TEXT NOT NULL,
  to_mode TEXT NOT NULL
);
