-- C380 B8a (S1-1): the company floor, a copy that outlives the Governance read model. Only a later full valid read of the
-- feed replaces it (src/floor.ts): a refusal, an expiry, an outage or a crash never touches it, and the gate reads it
-- without asking whether the Fleet facts are available.
--
-- kind: agent | contact | handle. id: the agent id, the contact id, or the canonical handle. code: why (blocked, suspended,
-- leaving, archived, not_started, departed, listed). holder: the agent or contact the entry belongs to (`agent:<id>`,
-- `contact:<id>`), so the owner can clear one holder with its handles. revision: the feed revision that first listed it.
CREATE TABLE floor_entries (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  code TEXT NOT NULL,
  holder TEXT NOT NULL,
  revision INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX floor_entries_holder ON floor_entries (holder);

-- feed_revision: the revision of the last full read that asked for lifecycle facts (Governance compares its own revision with
-- it before it says "Rules has this change"). last_gate_at: when the gate last ran, written at most once a minute.
CREATE TABLE floor_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  feed_revision INTEGER,
  read_at INTEGER,
  last_gate_at INTEGER
);
INSERT INTO floor_state (id) VALUES (1);

-- The owner's Clear (person op floor_clear): who lifted what and when. Kept: the floor overrides every rule, so its way out is recorded.
CREATE TABLE floor_clears (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  holder TEXT,
  entries INTEGER NOT NULL
);
