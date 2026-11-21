/**
 * Sign-up gate for machine-generated account names/usernames (UUIDs, hashes,
 * random character strings like "aPveyXtWPlzzRzvHwYbEuGT"). Behind
 * USERNAME_GATE_ENABLED=true.
 *
 * The sign-up form only sends `name`, so that is what is normally checked; a
 * `username`, when present, is checked too. When either is flagged, the user row is created already
 * banned (banReason = USERNAME_GATE_BAN_REASON) and no verification OTP is
 * ever emailed to it. Nothing about this is surfaced to the requester: sign-up
 * responds exactly as it would for a legitimate account.
 *
 * Any failure (missing key, timeout, API error, odd output) fails OPEN: the
 * account is treated as legitimate, so an OpenAI outage never blocks sign-ups.
 */
import OpenAI from "openai";

export const USERNAME_GATE_BAN_REASON = "auto:username-gate";

const MODEL = "gpt-6-luna";
// Kept terse on purpose: ~40 input tokens + a 1-letter answer per sign-up.
const INSTRUCTIONS =
  "Account name check. Reply G if it is random gibberish (UUID, hash, random chars), else N.";

const UUID_RE =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const HEX_RE = /^(0x)?[0-9a-f]{16,}$/i;

export function usernameGateEnabled(): boolean {
  return process.env.USERNAME_GATE_ENABLED === "true";
}

let client: OpenAI | undefined;

async function classifyWithLLM(username: string): Promise<boolean> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  client ??= new OpenAI({ apiKey, timeout: 5000, maxRetries: 1 });
  const res = await client.responses.create({
    model: MODEL,
    instructions: INSTRUCTIONS,
    input: username,
    // effort "none" is required: without it the model spends the whole
    // output budget on reasoning tokens and returns an empty answer.
    reasoning: { effort: "none" },
    max_output_tokens: 16,
    store: false,
  });
  return res.output_text.trim().toUpperCase().startsWith("G");
}

/** True when the username looks machine-generated. Never throws. */
export async function isGibberishUsername(
  username: string,
  classify: (u: string) => Promise<boolean> = classifyWithLLM,
): Promise<boolean> {
  const u = username.trim();
  if (!u) return false;
  // Literal UUIDs / long hex hashes need no model call.
  if (UUID_RE.test(u) || HEX_RE.test(u)) return true;
  try {
    return await classify(u);
  } catch (e) {
    console.warn("[username-gate] classification failed, allowing:", e);
    return false;
  }
}

type NewUser = Record<string, unknown> & {
  name?: string | null;
  username?: string | null;
  displayUsername?: string | null;
};

/**
 * databaseHooks.user.create.before handler. Returns the user marked banned
 * when its name or username is flagged, otherwise undefined (no change).
 */
export async function gateNewUser<T extends NewUser>(
  user: T,
  classify?: (u: string) => Promise<boolean>,
): Promise<{ data: T & { banned: true; banReason: string } } | undefined> {
  if (!usernameGateEnabled()) return;
  const candidates = [
    ...new Set(
      [user.name, user.displayUsername || user.username]
        .map((v) => v?.trim())
        .filter((v): v is string => !!v),
    ),
  ];
  let flagged: string | undefined;
  for (const c of candidates)
    if (await isGibberishUsername(c, classify)) {
      flagged = c;
      break;
    }
  if (!flagged) return;
  console.info(`[username-gate] silently banned new sign-up "${flagged}"`);
  return {
    data: { ...user, banned: true, banReason: USERNAME_GATE_BAN_REASON },
  };
}

/**
 * True when auth emails to this user must be suppressed because the account
 * was banned by this gate. Applies regardless of the flag so that turning the
 * flag off later never starts mailing already-flagged accounts.
 */
export function isGateBannedUser(
  user: { banned?: boolean | null; banReason?: string | null } | null | undefined,
): boolean {
  return user?.banned === true && user.banReason === USERNAME_GATE_BAN_REASON;
}
