-- Drop the dead supabase_links table.
--
-- The Supabase integration was removed; this table is no longer referenced by
-- schema.ts or any application code, and nothing has a foreign key pointing at
-- it. Applied out-of-band (the team syncs schema via `db:push`, and `db:generate`
-- won't emit a drop for a table absent from schema.ts).
DROP TABLE IF EXISTS supabase_links;
