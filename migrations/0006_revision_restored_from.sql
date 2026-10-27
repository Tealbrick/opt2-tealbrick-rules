-- 0.5 (C373, Q-7): a rule can be restored to an earlier revision. The restore writes a NEW revision row with change
-- 'restored'; `from_rev` names the revision whose spec it copied. Additive (expand) only: older rows keep NULL.
ALTER TABLE rule_revisions ADD COLUMN from_rev INTEGER;
