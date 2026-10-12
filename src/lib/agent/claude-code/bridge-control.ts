/**
 * Bridge process control — the sandbox-side contracts shared by the spawn
 * route (kill the thread's previous bridge and admit the new one), the stop
 * route (kill on user Stop), and the reattach route (tail the live turn's
 * events). Everything is scoped per THREAD: each thread runs its own bridge
 * in the project's shared sandbox (docs/features/multi-agent-threads.md).
 *
 * The bridge runs DETACHED in the sandbox, so it survives the 300s death of
 * the serverless route that spawned it. That's by design (the turn keeps
 * making progress), but it means process lifecycle must be managed from
 * here, not from the route's request lifetime:
 *
 *   - pidfile: the bridge writes its own pid to its thread's pidfile on startup.
 *   - kill: TERM the bridge (it handles SIGTERM by interrupting the Claude
 *     Code subprocess), wait up to ~3s, then KILL. Children are pkill'd so a
 *     lingering `claude` CLI can't keep editing files after its turn died.
 *   - tail: stream the turn's NDJSON event file from the beginning, following
 *     while the bridge is alive (GNU `tail --pid` exits when it dies). Falls
 *     back to a plain `cat` when the bridge is already gone or tail lacks
 *     --pid (non-GNU userland).
 */

/** Directory for all per-turn bridge bookkeeping inside the sandbox. */
export const BRIDGE_RUN_DIR = "/tmp/botflow-cc";

/** Pre-threads single-bridge pidfile. Still honored by the capacity count so
 *  a bridge spawned by the previous deploy isn't invisible. */
const LEGACY_BRIDGE_PID_FILE = `${BRIDGE_RUN_DIR}/bridge.pid`;

/** Thread ids are uuids; anything else must never reach a shell script. */
function assertSafeThreadId(threadId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) {
    throw new Error(`invalid thread id: ${threadId}`);
  }
  return threadId;
}

/** Per-thread bookkeeping directory. */
export function threadRunDir(threadId: string): string {
  return `${BRIDGE_RUN_DIR}/threads/${assertSafeThreadId(threadId)}`;
}

/** Pidfile of the thread's currently-running bridge. */
export function threadPidFile(threadId: string): string {
  return `${threadRunDir(threadId)}/bridge.pid`;
}

/** OpenCode abort sentinel for the thread's bridge. */
export function threadAbortFile(threadId: string): string {
  return `${threadRunDir(threadId)}/abort`;
}

/** NDJSON event tee file for a turn. */
export function turnEventFile(turnId: string): string {
  return `${BRIDGE_RUN_DIR}/turn-${turnId}.ndjson`;
}

/** Sandbox capacity knobs (docs/features/multi-agent-threads.md §5). Env-tunable
 *  without a deploy; calibrate AGENT_MEM_RESERVE_MB from measured agent RSS. */
export interface CapacityLimits {
  /** Hard ceiling on concurrently running bridges per sandbox. */
  maxRunning: number;
  /** Memory one more agent is expected to need. */
  agentReserveMb: number;
  /** Memory always kept free for the dev server, builds, and installs. */
  floorMb: number;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function capacityLimits(): CapacityLimits {
  return {
    maxRunning: envInt("MAX_RUNNING_AGENTS_PER_PROJECT", 6),
    agentReserveMb: envInt("AGENT_MEM_RESERVE_MB", 700),
    floorMb: envInt("SANDBOX_MEM_FLOOR_MB", 512),
  };
}

/** Kill the bridge whose pid is in `pidFile` (graceful TERM → KILL, children
 *  first so a lingering agent CLI can't keep editing files), then clear it. */
function killPidfileLines(pidFile: string): string[] {
  return [
    `if [ -f ${pidFile} ]; then`,
    `  PID=$(cat ${pidFile} 2>/dev/null)`,
    `  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then`,
    // TERM children first (the agent CLI) so it stops touching files, then
    // the bridge itself (its SIGTERM handler interrupts the agent cleanly).
    `    pkill -TERM -P "$PID" 2>/dev/null || true`,
    `    kill -TERM "$PID" 2>/dev/null || true`,
    `    i=0`,
    `    while [ $i -lt 30 ] && kill -0 "$PID" 2>/dev/null; do sleep 0.1; i=$((i+1)); done`,
    `    if kill -0 "$PID" 2>/dev/null; then`,
    `      pkill -KILL -P "$PID" 2>/dev/null || true`,
    `      kill -KILL "$PID" 2>/dev/null || true`,
    `    fi`,
    `  fi`,
    `  rm -f ${pidFile}`,
    `fi`,
  ];
}

/** Printed by the prepare script when the turn may NOT start. */
export const CAPACITY_FULL_MARKER = "BOTFLOW_CAPACITY_FULL";
/** Printed when the thread's own bridge is still alive — the new message
 *  must queue behind it (one live turn per thread; it is never killed). */
export const THREAD_BUSY_MARKER = "BOTFLOW_THREAD_BUSY";

/**
 * Shell script that refuses when the THREAD's bridge is still alive (one live
 * turn per thread — a new message queues behind it, it never kills it),
 * clears a stale pidfile, sweeps stale per-turn files, runs the capacity
 * admission check, and pre-creates the new turn's event file so a reattach
 * `tail -f` never races file creation. Other threads' bridges are untouched.
 *
 * Admission (both must pass):
 *   - fewer than `maxRunning` other bridges alive in this sandbox;
 *   - available memory ≥ agentReserveMb + floorMb, read from cgroup v2
 *     (memory.max − memory.current) when the sandbox has a limit, else
 *     /proc/meminfo MemAvailable.
 * On refusal it prints `THREAD_BUSY_MARKER` or
 * `CAPACITY_FULL_MARKER running=<n> availMb=<m>` and exits 0 without creating
 * the event file — the starter turns that into a 409 / 429.
 *
 * Runs as ONE runCommand so a new turn pays a single sandbox round-trip.
 */
export function buildPrepareTurnScript(
  threadId: string,
  newEventFile: string,
  limits: CapacityLimits = capacityLimits(),
): string {
  const dir = threadRunDir(threadId);
  const need = limits.agentReserveMb + limits.floorMb;
  return [
    `mkdir -p ${dir}`,
    // ── One live turn per thread: refuse (don't kill) while it runs ───────
    `if [ -f ${threadPidFile(threadId)} ]; then`,
    `  PID=$(cat ${threadPidFile(threadId)} 2>/dev/null)`,
    `  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo "${THREAD_BUSY_MARKER}"; exit 0; fi`,
    `  rm -f ${threadPidFile(threadId)}`,
    `fi`,
    // ── Sweep stale turn artifacts (>6h) — configs too ────────────────────
    `find ${BRIDGE_RUN_DIR} -maxdepth 1 -name 'turn-*.ndjson' -mmin +360 -delete 2>/dev/null || true`,
    `find /tmp -maxdepth 1 -name '.botflow-claude-config-*.json' -mmin +360 -delete 2>/dev/null || true`,
    `find /tmp -maxdepth 1 -name '.botflow-opencode-config-*.json' -mmin +360 -delete 2>/dev/null || true`,
    // Stale abort sentinel from this thread's previous OpenCode turn must
    // not abort this one.
    `rm -f ${threadAbortFile(threadId)}`,
    // ── Capacity admission ────────────────────────────────────────────────
    `RUNNING=0`,
    `for F in ${BRIDGE_RUN_DIR}/threads/*/bridge.pid ${LEGACY_BRIDGE_PID_FILE}; do`,
    `  [ -f "$F" ] || continue`,
    `  P=$(cat "$F" 2>/dev/null)`,
    `  if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then RUNNING=$((RUNNING+1)); fi`,
    `done`,
    `AVAIL_KB=""`,
    `if [ -r /sys/fs/cgroup/memory.max ] && [ -r /sys/fs/cgroup/memory.current ]; then`,
    `  MAX=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)`,
    `  CUR=$(cat /sys/fs/cgroup/memory.current 2>/dev/null)`,
    `  if [ -n "$MAX" ] && [ "$MAX" != "max" ] && [ -n "$CUR" ]; then AVAIL_KB=$(( (MAX - CUR) / 1024 )); fi`,
    `fi`,
    `if [ -z "$AVAIL_KB" ]; then AVAIL_KB=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null); fi`,
    `AVAIL_MB=$(( \${AVAIL_KB:-0} / 1024 ))`,
    `if [ "$RUNNING" -ge ${limits.maxRunning} ] || { [ -n "$AVAIL_KB" ] && [ "$AVAIL_MB" -lt ${need} ]; }; then`,
    `  echo "${CAPACITY_FULL_MARKER} running=$RUNNING availMb=$AVAIL_MB"`,
    `  exit 0`,
    `fi`,
    // ── Pre-create the new event file so tail -f can attach immediately ───
    `: > ${newEventFile}`,
    `true`,
  ].join("\n");
}

/** True when the prepare script refused because the thread is mid-turn. */
export function parseThreadBusy(stdout: string): boolean {
  return stdout.split("\n").some((l) => l.trim() === THREAD_BUSY_MARKER);
}

/** Parse the prepare script's stdout. Null = admitted (or busy — check first). */
export function parseCapacityRefusal(stdout: string): { running: number; availMb: number } | null {
  const line = stdout.split("\n").find((l) => l.startsWith(CAPACITY_FULL_MARKER));
  if (!line) return null;
  const running = Number(/running=(\d+)/.exec(line)?.[1] ?? 0);
  const availMb = Number(/availMb=(\d+)/.exec(line)?.[1] ?? 0);
  return { running, availMb };
}

/** Kill-only variant for the stop route (no new turn being prepared). */
export function buildKillBridgeScript(threadId: string): string {
  return [...killPidfileLines(threadPidFile(threadId)), `true`].join("\n");
}

/**
 * Shell script that streams a turn's event file:
 *   - thread's bridge alive → dump from byte 0 and FOLLOW until it exits
 *     (GNU tail --pid). If tail errors (BusyBox userland, etc.) it prints
 *     nothing and we fall back to a one-shot cat.
 *   - bridge dead → one-shot cat of whatever was written.
 */
export function buildTailTurnScript(threadId: string, eventFile: string): string {
  const pidFile = threadPidFile(threadId);
  return [
    `PID=$(cat ${pidFile} 2>/dev/null)`,
    `if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then`,
    `  if tail -c +1 -f --pid="$PID" ${eventFile} 2>/dev/null; then`,
    `    :`,
    `  else`,
    `    cat ${eventFile} 2>/dev/null || true`,
    `  fi`,
    `else`,
    `  cat ${eventFile} 2>/dev/null || true`,
    `fi`,
    `true`,
  ].join("\n");
}

/** One-shot read of a finished (or dying) turn's event file. */
export function buildReadTurnScript(eventFile: string): string {
  return `cat ${eventFile} 2>/dev/null || true`;
}
