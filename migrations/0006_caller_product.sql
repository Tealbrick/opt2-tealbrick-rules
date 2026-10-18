-- 0.3.2 (C237, S4-3): the VERIFIED product of an app caller, recorded with each decision (spec 0.1.45 HookCallInfo.caller.product).
-- NULL for an agent, for an app the bridge could not map (or a bridge older than 0.2.2), and for every row recorded before 0.3.2.
-- rules_explain reads an app's decisions by this column and falls back to caller_id (the instance id) for rows where it is NULL.
-- Forward-only; no existing row changes.
ALTER TABLE decisions ADD COLUMN caller_product TEXT;
CREATE INDEX decisions_by_caller_product ON decisions (caller_product, id DESC);
