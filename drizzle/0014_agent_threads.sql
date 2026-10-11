-- Multi-agent threads (docs/features/multi-agent-threads.md, Phase 1).
-- chat_sessions becomes the threads table: N per project, each with its own
-- title, model, and conversation segment. Idempotent — safe to re-run.
-- Run via: node scripts/migrate-agent-threads.mjs
-- (No semicolons inside statements: the runner splits on them.)

-- ── Thread columns ────────────────────────────────────────────────────────
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS current_segment_id uuid;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS archived_at timestamp;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS last_turn_started_at timestamp;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS last_turn_ended_at timestamp;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS last_turn_error text;
CREATE INDEX IF NOT EXISTS chat_sessions_project_id_idx ON chat_sessions (project_id);

-- Per-user unread tracking.
CREATE TABLE IF NOT EXISTS chat_thread_views (
  thread_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  last_viewed_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

-- Author of user messages (null on assistant messages and legacy rows).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS user_id text;

-- Which thread raised a question / HITL request — drives that thread's
-- "needs input" status. The one-pending-per-PROJECT indexes stay as they are.
ALTER TABLE chat_questions ADD COLUMN IF NOT EXISTS thread_id uuid;
ALTER TABLE oauth_provider_requests ADD COLUMN IF NOT EXISTS thread_id uuid;
ALTER TABLE env_var_requests ADD COLUMN IF NOT EXISTS thread_id uuid;
ALTER TABLE stripe_connect_requests ADD COLUMN IF NOT EXISTS thread_id uuid;

-- ── Backfill: one thread per old conversation segment ────────────────────
-- Un-migrated sessions are exactly those with current_segment_id IS NULL
-- (new threads always get one). Each project had at most one session, whose
-- messages are stamped with the segment they were written in. The project's
-- CURRENT segment stays in the original session. Every other segment moves
-- into a new thread of its own.

-- 1. Create a thread per non-current segment.
INSERT INTO chat_sessions (id, project_id, model, current_segment_id, created_at, updated_at)
SELECT gen_random_uuid(), s.project_id, p.model, g.segment_id, g.first_at, g.last_at
FROM chat_sessions s
JOIN projects p ON p.id = s.project_id
JOIN (
  SELECT session_id, segment_id, min(created_at) AS first_at, max(created_at) AS last_at
  FROM chat_messages
  WHERE segment_id IS NOT NULL
  GROUP BY session_id, segment_id
) g ON g.session_id = s.id
WHERE s.current_segment_id IS NULL
  AND g.segment_id IS DISTINCT FROM p.current_segment_id
  AND NOT EXISTS (
    SELECT 1 FROM chat_sessions t
    WHERE t.project_id = s.project_id AND t.current_segment_id = g.segment_id
  );

-- 2. Move those segments' messages into their new threads.
UPDATE chat_messages m
SET session_id = t.id
FROM chat_sessions s, chat_sessions t
WHERE m.session_id = s.id
  AND s.current_segment_id IS NULL
  AND t.project_id = s.project_id
  AND t.id <> s.id
  AND t.current_segment_id = m.segment_id;

-- 3. The original session keeps the current segment (mint one if the project
--    never had a segment). This also marks it migrated.
UPDATE chat_sessions s
SET current_segment_id = coalesce(p.current_segment_id, gen_random_uuid()),
    model = coalesce(s.model, p.model)
FROM projects p
WHERE p.id = s.project_id
  AND s.current_segment_id IS NULL;

-- 4. Titles from each thread's first user message.
UPDATE chat_sessions t
SET title = left(regexp_replace(x.text, '\s+', ' ', 'g'), 80)
FROM (
  SELECT DISTINCT ON (m.session_id) m.session_id, part->>'text' AS text
  FROM chat_messages m
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(m.content->'parts') = 'array' THEN m.content->'parts' ELSE '[]'::jsonb END
  ) AS part
  WHERE m.role = 'user'
    AND part->>'type' = 'text'
    AND coalesce(part->>'text', '') <> ''
    AND part->>'text' NOT LIKE '[system-note]%'
  ORDER BY m.session_id, m.created_at
) x
WHERE x.session_id = t.id
  AND t.title IS NULL;

-- 5. Attribute questions to the thread that owns their segment.
UPDATE chat_questions q
SET thread_id = t.id
FROM chat_sessions t
WHERE q.thread_id IS NULL
  AND q.segment_id IS NOT NULL
  AND t.project_id = q.project_id
  AND t.current_segment_id = q.segment_id;
