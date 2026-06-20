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
import sharp from "sharp";
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

// Charged at-cost, like the rest of the credit system. Credit unit = one
// Minimax-M3 input token = $0.30 / 1M = $3e-7 (credits.ts: minimax input
// multiplier 0.30/0.30 = 1).
//
// We use gpt-image-2 MEDIUM quality for icons — 'high' is overkill for a bold,
// simple graphic and ~4x the price. Pure text→image (no input image):
//   medium 1024² output  = $0.053  → $0.053 / $3e-7 = 176,667 credits
//   prompt (text input)  = prefix (~95 tok) + max user prompt (160 chars,
//                          worst-case ~160 tok) ≈ 255 tok × $5/1M = $0.0013
//                          → ~4,300 credits
//   worst case ≈ 181k → 185,000 credits.
// This fits the free weekly budget (500k), so free users get ~2/week. Bump the
// quality below to 'high' (~710k) for max fidelity, or 'low' (~20k) for cheap.
export const ICON_GENERATION_CREDITS = 185_000;

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
      // 'medium' is the sweet spot for a bold, simple icon (see ICON_GENERATION_CREDITS).
      quality: "medium",
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

  // The image is already paid for, so a write failure is non-fatal — we still
  // return the icon for preview and let the user retry.
  const writtenTo = await writeIconToAssetCatalog(opts.projectId, pngBuffer);

  // ── Record the charge (monthly DB; the weekly reservation = the real cost) ──
  await recordTokenUsage(opts.userId, "gpt-image-2", 0, 0, ICON_GENERATION_CREDITS).catch(() => {});

  return {
    ok: true,
    iconDataUrl: `data:image/png;base64,${pngBuffer.toString("base64")}`,
    creditsCharged: ICON_GENERATION_CREDITS,
    writtenTo,
  };
}

/**
 * Write a 1024px PNG into the project's AppIcon.appiconset (defaulting the path
 * if the project has none). Returns the project-relative dir, or null on
 * failure. Because it lands in the project SOURCE, the icon persists across
 * sessions and is included in every subsequent publish build.
 */
export async function writeIconToAssetCatalog(
  projectId: string,
  pngBuffer: Buffer,
): Promise<string | null> {
  try {
    const dirRes = await sandboxBash(
      projectId,
      `find . -type d -name AppIcon.appiconset 2>/dev/null | head -1`,
      { timeoutMs: 15_000 },
    );
    const rel =
      (dirRes.stdout || "").trim().replace(/^\.\//, "") ||
      "Resources/Assets.xcassets/AppIcon.appiconset";
    await sandboxWriteBinaryFile(projectId, `${rel}/AppIcon.png`, pngBuffer);
    await sandboxWriteFile(projectId, `${rel}/Contents.json`, ICON_CONTENTS_JSON);
    return rel;
  } catch (e) {
    console.error(
      "[app-store-readiness/icon] sandbox write failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

// Generous cap on an uploaded source image (pre-normalization).
export const MAX_ICON_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * Set the app icon from a USER-UPLOADED image — no model, no credits. Normalizes
 * to a 1024×1024 OPAQUE PNG (the App Store rejects alpha channels and off-size
 * icons) before writing it into the asset catalog, so a slightly-off upload
 * still produces a valid icon.
 */
export async function setUploadedAppIcon(opts: {
  projectId: string;
  imageBuffer: Buffer;
}): Promise<
  | { ok: true; iconDataUrl: string; writtenTo: string | null }
  | { ok: false; status: number; error: string }
> {
  let png: Buffer;
  try {
    png = await sharp(opts.imageBuffer)
      .resize(1024, 1024, { fit: "cover" })
      // Composite over white to drop any alpha channel — App Store icons must be
      // fully opaque. A no-op for images that are already opaque.
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();
  } catch {
    return { ok: false, status: 400, error: "That doesn't look like a valid image. Upload a PNG or JPEG." };
  }
  const writtenTo = await writeIconToAssetCatalog(opts.projectId, png);
  if (!writtenTo) {
    return { ok: false, status: 500, error: "Couldn't write the icon into your project." };
  }
  return {
    ok: true,
    iconDataUrl: `data:image/png;base64,${png.toString("base64")}`,
    writtenTo,
  };
}
