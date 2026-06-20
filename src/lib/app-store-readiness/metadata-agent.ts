/**
 * App Store metadata drafting (Minimax M3).
 *
 * A one-shot, non-streaming model call (separate from the main chat agent) that
 * reads the project's Swift source for grounding and drafts name / subtitle /
 * description / keywords within Apple's exact limits. Billed to the user's
 * credits (reserve an estimate, reconcile to actual usage).
 */

import { generateText, tool } from "ai";
import { createFireworks } from "@ai-sdk/fireworks";
import { z } from "zod";
import { getUserTier } from "@/lib/tier";
import {
  adjustWeeklyCredits,
  calculateCredits,
  getMonthlyCredits,
  getMonthlyLimit,
  getWeeklyLimit,
  reserveWeeklyCredits,
} from "@/lib/credits";
import { recordTokenUsage } from "@/lib/usage";
import { sandboxBash } from "@/lib/vercel-sandbox";

const MINIMAX_API_MODEL = "accounts/fireworks/models/minimax-m3";
const MINIMAX_CREDIT_MODEL = "fireworks-minimax-m3";

// Apple's hard limits.
const LIMITS = { name: 30, subtitle: 30, description: 4000, keywords: 100 } as const;

export interface DraftedMetadata {
  name: string;
  subtitle: string;
  description: string;
  keywords: string;
}

export type MetadataResult =
  | { ok: true; metadata: DraftedMetadata; creditsCharged: number }
  | { ok: false; status: number; error: string; insufficientCredits?: boolean };

const metadataSchema = z.object({
  name: z.string().describe("App Store display name, max 30 chars, no emoji"),
  subtitle: z.string().describe("Short subtitle / tagline, max 30 chars"),
  description: z
    .string()
    .describe("Compelling App Store description, max 4000 chars, plain text, short scannable paragraphs"),
  keywords: z
    .string()
    .describe("Comma-separated keywords, max 100 chars total, no spaces after commas, don't repeat words from the name"),
});

function clamp(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length <= max ? t : t.slice(0, max).trim();
}

export async function draftAppStoreMetadata(opts: {
  projectId: string;
  userId: string;
  appName: string;
}): Promise<MetadataResult> {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 500, error: "Metadata generation isn't configured." };
  }

  // ── Budget: monthly cap + atomic weekly reservation (estimate) ───────────
  const tier = await getUserTier(opts.userId);
  if ((await getMonthlyCredits(opts.userId)) >= getMonthlyLimit(tier)) {
    return { ok: false, status: 402, error: "You've reached your monthly credit limit.", insufficientCredits: true };
  }
  const estimate = calculateCredits({
    model: MINIMAX_CREDIT_MODEL,
    inputTokens: 8_000,
    outputTokens: 1_500,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
  });
  if (!(await reserveWeeklyCredits(opts.userId, estimate, getWeeklyLimit(tier)))) {
    return { ok: false, status: 402, error: "Not enough weekly credits left to draft metadata.", insufficientCredits: true };
  }

  // ── Ground the draft on the project's real source ────────────────────────
  let context = "";
  try {
    const res = await sandboxBash(
      opts.projectId,
      `find Sources -name '*.swift' 2>/dev/null | head -12 | xargs cat 2>/dev/null | head -c 6000`,
      { timeoutMs: 15_000 },
    );
    context = res.stdout || "";
  } catch {
    /* best-effort grounding */
  }

  let drafted: DraftedMetadata;
  let inTok = 0;
  let outTok = 0;
  try {
    const fireworks = createFireworks({ apiKey });
    const result = await generateText({
      model: fireworks(MINIMAX_API_MODEL),
      system:
        "You are an App Store Optimization (ASO) expert. Write compelling, HONEST App Store " +
        "metadata for an iOS app. Respect Apple's exact limits: name ≤30 chars, subtitle ≤30 " +
        "chars, description ≤4000 chars, keywords ≤100 chars total (comma-separated, no spaces " +
        "after commas, don't repeat words already in the name). No emoji in name or subtitle. Be " +
        "specific to the app's REAL features from the source — never invent capabilities. Call the " +
        "submit tool exactly once.",
      prompt:
        `App working name: ${opts.appName}\n\n` +
        `App source (to understand what it actually does):\n\n` +
        `${context || "(no source available — infer reasonably from the name)"}\n\n` +
        `Draft the App Store metadata now.`,
      tools: { submit: tool({ description: "Submit the drafted App Store metadata", inputSchema: metadataSchema }) },
      toolChoice: { type: "tool", toolName: "submit" },
      maxRetries: 2,
    });
    inTok = result.usage?.inputTokens ?? 0;
    outTok = result.usage?.outputTokens ?? 0;
    const out = result.toolCalls[0]?.input as z.infer<typeof metadataSchema> | undefined;
    if (!out) throw new Error("model returned no metadata");
    drafted = {
      name: clamp(out.name || opts.appName, LIMITS.name),
      subtitle: clamp(out.subtitle, LIMITS.subtitle),
      description: clamp(out.description, LIMITS.description),
      keywords: clamp(out.keywords, LIMITS.keywords),
    };
  } catch (e) {
    await adjustWeeklyCredits(opts.userId, -estimate).catch(() => {});
    console.error("[app-store-readiness/metadata] draft failed:", e instanceof Error ? e.message : e);
    return { ok: false, status: 502, error: "Couldn't draft metadata. Try again." };
  }

  // ── Reconcile reservation → actual usage ─────────────────────────────────
  const actual = calculateCredits({
    model: MINIMAX_CREDIT_MODEL,
    inputTokens: inTok,
    outputTokens: outTok,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
  });
  await recordTokenUsage(opts.userId, MINIMAX_CREDIT_MODEL, inTok, outTok, actual).catch(() => {});
  await adjustWeeklyCredits(opts.userId, actual - estimate).catch(() => {});

  return { ok: true, metadata: drafted, creditsCharged: actual };
}
