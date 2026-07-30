/**
 * Refresh the MuhKoo platform developer session.
 *
 *   pnpm muhkoo:auth              # browser login (loopback PKCE, ~10 seconds)
 *   pnpm muhkoo:auth --token <t>  # paste a token from portal.muhkoo.dev instead
 *
 * MuhKoo expires the developer session roughly daily and offers no server-side
 * refresh, so this is a routine operator task. Every MuhKoo management-plane
 * call depends on it: provisioning apps, creating tables, listing schema,
 * minting per-project access tokens.
 *
 * The refreshed token is written to `platform_secrets` (envelope-encrypted),
 * NOT to an env var — so it takes effect without a redeploy, and because local
 * and production share one database, this refreshes both at once.
 */
import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setMuhkooDevToken, checkMuhkooSession } from "../lib/muhkoo-session";

config({ path: ".env.local" });

const CLI_CONFIG = path.join(os.homedir(), ".muhkoo", "config.json");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Read `{ token, base, username }` from the CLI's config file. */
function readCliConfig(): { token?: string; base?: string; username?: string } {
  try {
    return JSON.parse(fs.readFileSync(CLI_CONFIG, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  let token = argValue("--token");
  let username: string | undefined;

  if (!token) {
    // `login --web` is loopback PKCE against auth.muhkoo.dev — no prover, no
    // snarkjs, credentials never touch this process. It writes the session to
    // ~/.muhkoo/config.json, which we read back below.
    const before = readCliConfig().token;
    console.log("Opening your browser to sign in to MuhKoo…\n");
    try {
      execFileSync("npx", ["-y", "@muhkoo/cli", "login", "--web"], {
        stdio: "inherit",
      });
    } catch {
      console.error(
        "\nBrowser login failed. You can instead copy the session token from " +
          "portal.muhkoo.dev and run:\n  pnpm muhkoo:auth --token <token>",
      );
      process.exitCode = 1;
      return;
    }

    const cfg = readCliConfig();
    token = cfg.token;
    username = cfg.username;
    if (!token) {
      console.error(`No session token found in ${CLI_CONFIG} after login.`);
      process.exitCode = 1;
      return;
    }
    if (token === before) {
      console.warn("Warning: the token in ~/.muhkoo/config.json did not change.");
    }

    // A token minted against staging will 401 against prod (and vice versa).
    const apiBase = (process.env.MUHKOO_API_BASE || "https://api.muhkoo.dev").replace(/\/+$/, "");
    const cliBase = (cfg.base || "").replace(/\/+$/, "");
    if (cliBase && cliBase !== apiBase) {
      console.warn(
        `\nWarning: you signed in to ${cliBase} but this app talks to ${apiBase}.\n` +
          "The token will not work. Re-run with `muhkoo login --web --base <env|url>`.",
      );
    }
  }

  await setMuhkooDevToken(token, username ?? "pnpm muhkoo:auth");

  const health = await checkMuhkooSession();
  if (!health.ok) {
    console.error(`\n✗ Stored, but the session did not verify: ${health.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n✓ MuhKoo session refreshed` +
      (health.developer?.email ? ` — ${health.developer.email}` : "") +
      (health.developer?.tier ? ` (${health.developer.tier})` : ""),
  );
  console.log("  Stored in the database — live for local and production, no redeploy.");
  console.log("  Serverless instances pick it up within ~60s (in-process cache TTL).");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
