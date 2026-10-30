-- C380 N2-2: a restored or reinstalled Governance must not lift the company floor. The floor remembers the highest feed revision it read and the feed's
-- epoch. A read that goes back, or comes with another epoch, marks the floor regressed: from then on reads only add, until the owner's Clear all.
-- floor_entries.listed = 0: the entry is kept for that reason, and Governance's current list does not have it.
ALTER TABLE floor_entries ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE floor_state ADD COLUMN high_revision INTEGER;
ALTER TABLE floor_state ADD COLUMN epoch TEXT;
ALTER TABLE floor_state ADD COLUMN regressed_at INTEGER;
ALTER TABLE floor_state ADD COLUMN regressed_from INTEGER;
ALTER TABLE floor_state ADD COLUMN regressed_to INTEGER;
ALTER TABLE floor_state ADD COLUMN regressed_why TEXT;
UPDATE floor_state SET high_revision = feed_revision;
