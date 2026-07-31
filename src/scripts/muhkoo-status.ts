/**
 * Is the MuhKoo platform developer session alive right now?
 *
 *   pnpm muhkoo:status
 *
 * Worth running before a demo: when this session is dead, NOTHING on the MuhKoo
 * management plane works — no new backends, no new tables, no schema listing.
 * Existing projects keep serving (deployed apps use the publishable key) and
 * the agent can still read rows via each project's own access token.
 *
 * MuhKoo exposes no session-introspection endpoint, so there is no
 * time-to-expiry to report — only alive or dead.
 */
import { config } from "dotenv";
import { checkMuhkooSession } from "../lib/muhkoo-session";

config({ path: ".env.local" });

async function main() {
  const h = await checkMuhkooSession();
  const base = (process.env.MUHKOO_API_BASE || "https://api.muhkoo.dev").replace(/\/+$/, "");

  if (h.ok) {
    console.log(`✓ MuhKoo session is live  (${base})`);
    if (h.developer?.email) {
      console.log(`  developer: ${h.developer.email}${h.developer.tier ? ` (${h.developer.tier})` : ""}`);
    }
    console.log(`  token source: ${h.source}${h.updatedAt ? `, refreshed ${h.updatedAt.toISOString()}` : ""}`);
    if (h.developer?.needsBootstrap) {
      console.log("  note: this developer account still needs bootstrapping.");
    }
    return;
  }

  console.error(`✗ MuhKoo session is DOWN  (${base})`);
  console.error(`  ${h.error}`);
  console.error(`  token source: ${h.source}`);
  console.error("\n  Fix: pnpm muhkoo:auth");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
