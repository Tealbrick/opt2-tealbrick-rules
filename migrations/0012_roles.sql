-- 0.7.0 (C380 T2-a): the roles of Governance, read from its feed (`accept: ["roles"]`), for the rule field `match.callerRoles`.
-- A role is team-like: an id, a name, and the agents and contacts that hold it now. It is kept apart from the teams (fleet_teams,
-- fleet_members) so that a rule that names a team never matches a role, and the other way round.
-- `active` follows the same rule as a team member: 1 = the holder counts for ALLOW rules (not blocked, departed or removed); deny and hold
-- rules see every holder.
--
-- Nothing is cleared here. Whether the copy was read WITH roles is kept in memory only (like the agent handles): after an update or a restart
-- the next read is a full one, and until then a rule that names roles reads the copy as unavailable (deny and hold apply, allow does not).
CREATE TABLE fleet_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  people INTEGER NOT NULL,
  agents INTEGER NOT NULL
);
CREATE TABLE fleet_role_members (
  role_id TEXT NOT NULL,
  member_key TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (role_id, member_key)
);
CREATE INDEX fleet_role_members_by_key ON fleet_role_members (member_key);
