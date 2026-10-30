// C380 T2-a: migration 0011 on 0.7.0-dev.1 data. The tables of the roles start empty, nothing that dev.1 stored changes (the Fleet copy stays usable), a role member is unique per role.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrationsDir } from "../src/app.ts";

const sql = (f: string) => readFileSync(join(migrationsDir, f), "utf8");

test("0011 on the data of 0.7.0-dev.1: everything stays, the copy stays usable, the roles start empty", () => {
  const raw = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort();
  assert.equal(files.indexOf("0011_roles.sql"), 10, "the next number after 0.7.0-dev.1");
  for (const f of files.slice(0, 10)) raw.exec(sql(f));
  raw.exec(`INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES ('rul_1', 1, '{"title":"x"}', 5, 1, 0, 'owner', 1, 1);
    UPDATE fleet_sync SET revision = 7, synced_at = 1, stale = 0, error = NULL, usable = 1 WHERE id = 1;
    INSERT INTO fleet_teams (id, name, people, agents) VALUES ('tm_x', 'Team X', 0, 1);
    INSERT INTO fleet_members (team_id, member_key, active) VALUES ('tm_x', 'agent:a', 1);
    INSERT INTO fleet_trust (member_key, trusts, all_active) VALUES ('agent:a', 'blocked', 0);
    INSERT INTO floor_entries (kind, id, code, holder, revision, at) VALUES ('agent', 'a', 'leaving', 'agent:a', 7, 1);`);
  const count = (t: string) => Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  const tables = ["rules", "fleet_teams", "fleet_members", "fleet_trust", "floor_entries"];
  const before = tables.map(count);
  raw.exec(sql("0011_roles.sql"));
  assert.deepEqual(tables.map(count), before);
  assert.deepEqual({ ...(raw.prepare("SELECT revision, usable, stale FROM fleet_sync WHERE id = 1").get() as object) }, { revision: 7, usable: 1, stale: 0 }, "the copy is not cleared by the update");
  assert.equal(count("fleet_roles"), 0);
  assert.equal(count("fleet_role_members"), 0);
  raw.exec("INSERT INTO fleet_roles (id, name, people, agents) VALUES ('rol_1', 'Contractor', 0, 1); INSERT INTO fleet_role_members (role_id, member_key, active) VALUES ('rol_1', 'agent:a', 1)");
  assert.throws(() => raw.exec("INSERT INTO fleet_role_members (role_id, member_key, active) VALUES ('rol_1', 'agent:a', 0)"), /UNIQUE/);
  assert.throws(() => raw.exec("INSERT INTO fleet_roles (id, name, people, agents) VALUES ('rol_1', 'Again', 0, 0)"), /UNIQUE/);
});
