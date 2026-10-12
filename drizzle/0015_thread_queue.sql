-- Multi-agent threads, Phase 2: server-side per-thread message queue.
-- A message sent to a thread whose agent is busy waits here (visible to every
-- project member) and is started server-side when the running turn ends.
-- Idempotent. Run via: node scripts/migrate-thread-queue.mjs

CREATE TABLE IF NOT EXISTS chat_thread_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  message jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  error text,
  turn_id text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_thread_queue_thread_status_idx
  ON chat_thread_queue (thread_id, status, created_at);
