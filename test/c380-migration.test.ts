// C380 B8a: migration 0010 on 0.6.0 data. The tables of the company floor start empty, nothing that 0.6.0 stored changes, and a second floor_state row cannot exist.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrationsDir } from "../src/app.ts";

const sql = (f: string) => readFileSync(join(migrationsDir, f), "utf8");

test("0010 on the data of 0.6.0: everything stays, the floor starts empty", () => {
  const raw = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort();
  assert.equal(files.indexOf("0010_floor.sql"), 9, "the next number after 0.6.0");
  for (const f of files.slice(0, 9)) raw.exec(sql(f));
  // what a 0.6.0 workspace holds: a rule with its revision, a read of the feed, a decision
  raw.exec(`INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES ('rul_1', 1, '{"title":"x"}', 5, 1, 0, 'owner', 1, 1);
    INSERT INTO rule_revisions (rule_id, rev, change, spec, actor, at) VALUES ('rul_1', 1, 'created', '{"title":"x"}', 'per_1', 1);
    UPDATE fleet_sync SET revision = 7, synced_at = 1, stale = 0, error = NULL, usable = 1 WHERE id = 1;
    INSERT INTO fleet_members (team_id, member_key, active) VALUES ('tm_x', 'agent:a', 1);
    INSERT INTO fleet_trust (member_key, trusts, all_active) VALUES ('agent:a', 'blocked', 0);
    INSERT INTO decisions (id, call_id, phase, at, caller_type, caller_id, product, op, effect, decision, answered, reason, duration_us) VALUES ('dec_1', 'cal_1', 'before', 1, 'agent', 'a', 'connect', 'buzz_dm', 'outward', 'deny', 'deny', 'no', 1);`);
  const count = (t: string) => Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  const before = ["rules", "rule_revisions", "fleet_members", "fleet_trust", "decisions"].map(count);
  raw.exec(sql("0010_floor.sql"));
  assert.deepEqual(["rules", "rule_revisions", "fleet_members", "fleet_trust", "decisions"].map(count), before);
  assert.equal((raw.prepare("SELECT revision FROM fleet_sync WHERE id = 1").get() as { revision: number }).revision, 7);
  assert.equal(count("floor_entries"), 0);
  assert.equal(count("floor_clears"), 0);
  assert.deepEqual({ ...(raw.prepare("SELECT * FROM floor_state").get() as object) }, { id: 1, feed_revision: null, read_at: null, last_gate_at: null });
  assert.throws(() => raw.exec("INSERT INTO floor_state (id) VALUES (2)"), /CHECK/);
  raw.exec("INSERT INTO floor_entries (kind, id, code, holder, revision, at) VALUES ('agent', 'a', 'leaving', 'agent:a', 7, 1)");
  assert.throws(() => raw.exec("INSERT INTO floor_entries (kind, id, code, holder, revision, at) VALUES ('agent', 'a', 'blocked', 'agent:a', 8, 2)"), /UNIQUE/);
});

test("0011 on the data of 0.7.0-dev.2: entries stay and count as listed; the high-water mark starts at the revision the floor has read; a stray file cannot jump the number", () => {
  const raw = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort();
  assert.equal(files.indexOf("0011_floor_regress.sql"), 10);
  for (const f of files.slice(0, 10)) raw.exec(sql(f));
  raw.exec(`INSERT INTO floor_entries (kind, id, code, holder, revision, at) VALUES ('agent', 'a', 'leaving', 'agent:a', 7, 1);
    INSERT INTO floor_clears (id, at, actor, holder, entries) VALUES ('flc_1', 1, 'per_1', NULL, 1);
    UPDATE floor_state SET feed_revision = 9, read_at = 5, last_gate_at = 6 WHERE id = 1;`);
  raw.exec(sql("0011_floor_regress.sql"));
  assert.deepEqual({ ...(raw.prepare("SELECT kind, id, code, holder, revision, at, listed FROM floor_entries").get() as object) }, { kind: "agent", id: "a", code: "leaving", holder: "agent:a", revision: 7, at: 1, listed: 1 });
  assert.deepEqual({ ...(raw.prepare("SELECT * FROM floor_state").get() as object) }, { id: 1, feed_revision: 9, read_at: 5, last_gate_at: 6, high_revision: 9, epoch: null, regressed_at: null, regressed_from: null, regressed_to: null, regressed_why: null });
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM floor_clears").get() as { n: number }).n, 1);
});
