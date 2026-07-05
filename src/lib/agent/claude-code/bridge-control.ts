/**
 * Bridge process control — the sandbox-side contracts shared by the spawn
 * route (kill the previous bridge before starting a new one), the stop route
 * (kill on user Stop), and the reattach route (tail the live turn's events).
 *
 * The bridge runs DETACHED in the sandbox, so it survives the 300s death of
 * the serverless route that spawned it. That's by design (the turn keeps
 * making progress), but it means process lifecycle must be managed from
 * here, not from the route's request lifetime:
 *
 *   - pidfile: the bridge writes its own pid to PID_FILE on startup.
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

/** Pidfile of the currently-running bridge (one bridge per project sandbox). */
export const BRIDGE_PID_FILE = `${BRIDGE_RUN_DIR}/bridge.pid`;

/** NDJSON event tee file for a turn. */
export function turnEventFile(turnId: string): string {
  return `${BRIDGE_RUN_DIR}/turn-${turnId}.ndjson`;
}

/**
 * Shell script that kills any previous bridge (graceful TERM → KILL), clears
 * the pidfile, sweeps stale per-turn files, and pre-creates the new turn's
 * event file so a reattach `tail -f` never races file creation.
 *
 * Idempotent and safe when nothing is running. Runs as ONE runCommand so a
 * new turn pays a single sandbox round-trip.
 */
export function buildPrepareTurnScript(newEventFile: string): string {
  return [
    `mkdir -p ${BRIDGE_RUN_DIR}`,
    // ── Kill the previous bridge, if any ──────────────────────────────────
    `if [ -f ${BRIDGE_PID_FILE} ]; then`,
    `  PID=$(cat ${BRIDGE_PID_FILE} 2>/dev/null)`,
    `  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then`,
    // TERM children first (the claude CLI) so it stops touching files, then
    // the bridge itself (its SIGTERM handler interrupts the SDK cleanly).
    `    pkill -TERM -P "$PID" 2>/dev/null || true`,
    `    kill -TERM "$PID" 2>/dev/null || true`,
    `    i=0`,
    `    while [ $i -lt 30 ] && kill -0 "$PID" 2>/dev/null; do sleep 0.1; i=$((i+1)); done`,
    `    if kill -0 "$PID" 2>/dev/null; then`,
    `      pkill -KILL -P "$PID" 2>/dev/null || true`,
    `      kill -KILL "$PID" 2>/dev/null || true`,
    `    fi`,
    `  fi`,
    `  rm -f ${BRIDGE_PID_FILE}`,
    `fi`,
    // ── Sweep stale turn artifacts (>6h) — configs too ────────────────────
    `find ${BRIDGE_RUN_DIR} -name 'turn-*.ndjson' -mmin +360 -delete 2>/dev/null || true`,
    `find /tmp -maxdepth 1 -name '.botflow-claude-config-*.json' -mmin +360 -delete 2>/dev/null || true`,
    `find /tmp -maxdepth 1 -name '.botflow-opencode-config-*.json' -mmin +360 -delete 2>/dev/null || true`,
    // Stale abort sentinel from a previous OpenCode turn must not abort this one.
    `rm -f ${BRIDGE_RUN_DIR}/abort`,
    // ── Pre-create the new event file so tail -f can attach immediately ───
    `: > ${newEventFile}`,
    `true`,
  ].join("\n");
}

/** Kill-only variant for the stop route (no new turn being prepared). */
export function buildKillBridgeScript(): string {
  return [
    `if [ -f ${BRIDGE_PID_FILE} ]; then`,
    `  PID=$(cat ${BRIDGE_PID_FILE} 2>/dev/null)`,
    `  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then`,
    `    pkill -TERM -P "$PID" 2>/dev/null || true`,
    `    kill -TERM "$PID" 2>/dev/null || true`,
    `    i=0`,
    `    while [ $i -lt 30 ] && kill -0 "$PID" 2>/dev/null; do sleep 0.1; i=$((i+1)); done`,
    `    if kill -0 "$PID" 2>/dev/null; then`,
    `      pkill -KILL -P "$PID" 2>/dev/null || true`,
    `      kill -KILL "$PID" 2>/dev/null || true`,
    `    fi`,
    `  fi`,
    `  rm -f ${BRIDGE_PID_FILE}`,
    `fi`,
    `true`,
  ].join("\n");
}

/**
 * Shell script that streams a turn's event file:
 *   - bridge alive → dump from byte 0 and FOLLOW until the bridge exits
 *     (GNU tail --pid). If tail errors (BusyBox userland, etc.) it prints
 *     nothing and we fall back to a one-shot cat.
 *   - bridge dead → one-shot cat of whatever was written.
 */
export function buildTailTurnScript(eventFile: string): string {
  return [
    `PID=$(cat ${BRIDGE_PID_FILE} 2>/dev/null)`,
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

/** One-shot liveness probe: prints ALIVE or DEAD. */
export function buildBridgeLivenessScript(): string {
  return [
    `PID=$(cat ${BRIDGE_PID_FILE} 2>/dev/null)`,
    `if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo ALIVE; else echo DEAD; fi`,
  ].join("\n");
}
