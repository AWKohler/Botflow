/**
 * App icon generation (GPT Image 2).
 *
 * Takes a short user prompt, prepends our opinionated app-icon art-direction
 * prefix, renders a 1024×1024 icon with gpt-image-2, and writes it into the
 * project's asset catalog so the build + the simulator preview both pick it up.
 * Billed to the user's credits (atomic weekly reservation, refunded if the
 * image service fails).
 */

import OpenAI from "openai";
import { getUserTier } from "@/lib/tier";
import {
  adjustWeeklyCredits,
  getMonthlyCredits,
  getMonthlyLimit,
  getWeeklyLimit,
  reserveWeeklyCredits,
} from "@/lib/credits";
import { recordTokenUsage } from "@/lib/usage";
import { sandboxBash, sandboxWriteBinaryFile, sandboxWriteFile } from "@/lib/vercel-sandbox";

// Raw OpenAI cost for a gpt-image-2 high-quality 1024² image is ≈ $0.17, which
// at the platform credit unit (~$0.30 / 1M credits) is ≈ 560k credits — more
// than a free user's whole weekly budget (500k). We deliberately price the icon
// BELOW raw cost so it stays an accessible value-add (~2/week on free, a small
// dent on pro/max). Tune here (or gate to paid) as the business sees fit.
export const ICON_GENERATION_CREDITS = 250_000;

// Forced-short to keep cost/latency down and steer the model toward a single
// clear subject rather than a scene.
export const MAX_ICON_PROMPT_CHARS = 160;

// Our art direction. The user's short prompt is appended as the SUBJECT only —
// everything that makes it read as an app icon (not a sticker, photo, or
// screenshot) is fixed here. Opinionated on purpose.
const ICON_PROMPT_PREFIX =
  "Design a professional iOS app icon. Single bold centered subject, clean " +
  "flat-vector or soft-3D style, strong silhouette readable at small sizes, " +
  "generous padding, one cohesive color palette, solid background. NO " +
  "text/letters/words, no UI screenshots, no rounded-corner frame, no device " +
  "mockup, no drop shadow, no photorealism. Subject: ";

// Single-size (1024) asset-catalog manifest — modern Xcode generates the rest.
const ICON_CONTENTS_JSON =
  JSON.stringify(
    {
      images: [{ filename: "AppIcon.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
      info: { author: "botflow", version: 1 },
    },
    null,
    2,
  ) + "\n";

export type IconResult =
  | { ok: true; iconDataUrl: string; creditsCharged: number; writtenTo: string | null }
  | { ok: false; status: number; error: string; insufficientCredits?: boolean };

export async function generateAppIcon(opts: {
  projectId: string;
  userId: string;
  userPrompt: string;
}): Promise<IconResult> {
  const userPrompt = opts.userPrompt.trim();
  if (!userPrompt) {
    return { ok: false, status: 400, error: "Describe the icon in a few words." };
  }
  if (userPrompt.length > MAX_ICON_PROMPT_CHARS) {
    return {
      ok: false,
      status: 400,
      error: `Keep the icon prompt under ${MAX_ICON_PROMPT_CHARS} characters.`,
    };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 500, error: "Image generation isn't configured." };
  }

  // ── Budget: monthly cap + atomic weekly reservation ──────────────────────
  const tier = await getUserTier(opts.userId);
  if ((await getMonthlyCredits(opts.userId)) >= getMonthlyLimit(tier)) {
    return {
      ok: false,
      status: 402,
      error: "You've reached your monthly credit limit.",
      insufficientCredits: true,
    };
  }
  const reserved = await reserveWeeklyCredits(
    opts.userId,
    ICON_GENERATION_CREDITS,
    getWeeklyLimit(tier),
  );
  if (!reserved) {
    return {
      ok: false,
      status: 402,
      error: "Not enough weekly credits left to generate an icon.",
      insufficientCredits: true,
    };
  }

  // ── Generate (refund the reservation on any failure) ─────────────────────
  let pngBuffer: Buffer;
  try {
    const openai = new OpenAI({ apiKey });
    const result = await openai.images.generate({
      model: "gpt-image-2",
      prompt: ICON_PROMPT_PREFIX + userPrompt,
      size: "1024x1024",
      quality: "high",
      n: 1,
    });
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new Error("no image data returned");
    pngBuffer = Buffer.from(b64, "base64");
  } catch (e) {
    await adjustWeeklyCredits(opts.userId, -ICON_GENERATION_CREDITS).catch(() => {});
    console.error(
      "[app-store-readiness/icon] generate failed:",
      e instanceof Error ? e.message : e,
    );
    return {
      ok: false,
      status: 502,
      error: "The image service couldn't generate an icon. Try a different prompt.",
    };
  }

  // ── Write into the project's AppIcon.appiconset (build + preview use it) ──
  // The image is already paid for, so a sandbox write failure is non-fatal — we
  // still return the icon for preview and let the user retry.
  let writtenTo: string | null = null;
  try {
    const dirRes = await sandboxBash(
      opts.projectId,
      `find . -type d -name AppIcon.appiconset 2>/dev/null | head -1`,
      { timeoutMs: 15_000 },
    );
    const rel =
      (dirRes.stdout || "").trim().replace(/^\.\//, "") ||
      "Resources/Assets.xcassets/AppIcon.appiconset";
    await sandboxWriteBinaryFile(opts.projectId, `${rel}/AppIcon.png`, pngBuffer);
    await sandboxWriteFile(opts.projectId, `${rel}/Contents.json`, ICON_CONTENTS_JSON);
    writtenTo = rel;
  } catch (e) {
    console.error(
      "[app-store-readiness/icon] sandbox write failed:",
      e instanceof Error ? e.message : e,
    );
  }

  // ── Record the charge (monthly DB; the weekly reservation = the real cost) ──
  await recordTokenUsage(opts.userId, "gpt-image-2", 0, 0, ICON_GENERATION_CREDITS).catch(() => {});

  return {
    ok: true,
    iconDataUrl: `data:image/png;base64,${pngBuffer.toString("base64")}`,
    creditsCharged: ICON_GENERATION_CREDITS,
    writtenTo,
  };
}
