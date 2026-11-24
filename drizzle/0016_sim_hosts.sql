-- Simulator host registry (admin panel → Simulators). One row per Mac that
-- serves the iOS simulator: its controller URL, runtime, macOS
-- generation (26 = Xcode Simulator, 27+ = Device Hub), hardware, capacity,
-- whether it is serving, and who it serves (everyone or beta users only).
-- Runtimes: isolated (build and simulator in Virtualization.framework VMs),
-- build-isolated (build in a VM, simulator on the Mac as a restricted user),
-- unsecure (both directly on the Mac).
-- Idempotent. Run via: node scripts/migrate-sim-hosts.mjs

CREATE TABLE IF NOT EXISTS sim_hosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  controller_url text NOT NULL,
  stream_url text,
  agent_host_id text,
  platform_token_enc text,
  runtime text NOT NULL DEFAULT 'build-isolated',
  macos_version text NOT NULL,
  hardware_model text,
  chip text,
  ram_gb integer,
  vm_cap_unlocked boolean NOT NULL DEFAULT false,
  max_sessions integer NOT NULL DEFAULT 2,
  serving boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'all',
  priority integer NOT NULL DEFAULT 100,
  notes text,
  last_test jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- The one Mac serving Botflow today: a MacBook Air (M2, 16 GB, macOS 26.7.1,
-- Xcode 26.6). Builds run in a tart VM; simulators run on the Mac as the
-- restricted simhost user. Its two-VM cap is removed. Its token is the deployment's
-- SIM_PLATFORM_TOKEN (platform_token_enc NULL). Seeded only into an empty
-- table, so re-running never duplicates it or undoes panel edits.
INSERT INTO sim_hosts (name, controller_url, stream_url, agent_host_id, runtime, macos_version,
                       hardware_model, chip, ram_gb, vm_cap_unlocked, max_sessions, serving, scope, priority, notes)
SELECT 'MacBook Air (M2)', 'https://sim.botflow-site.app', 'wss://sim.botflow-site.app', 'botflow-mba-26',
       'build-isolated', '26.7.1', 'MacBook Air', 'Apple M2', 16, true, 2, true, 'all', 10,
       'Original fleet host. Builds run in a tart VM (golden-v3, one build VM at a time, 4 CPU / 4 GB). Simulators run as the simhost user. Two-VM cap removed.'
WHERE NOT EXISTS (SELECT 1 FROM sim_hosts);
