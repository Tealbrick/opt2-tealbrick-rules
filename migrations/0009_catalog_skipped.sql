-- App catalog (0.5.0 dev.5, QA-C373-RU-3): the releases the last good index read could NOT read (a manifest URL that answered
-- 404, a manifest that failed its digest or its identity check), JSON [{product, version, reason}], NULL = none. One bad manifest
-- no longer looks like a failed catalog read: `error` stays for a failed INDEX read only. Additive; no row changes.
ALTER TABLE catalog_sync ADD COLUMN skipped TEXT;
