/**
 * AI image generation (FAL — Krea 2 Medium).
 *
 * Takes a text prompt + a project-relative output path + an aspect ratio,
 * renders the image synchronously via fal.run (the call returns only when
 * generation finishes), and writes the bytes into the project's sandbox so
 * the app can reference the file immediately.
 *
 * Billed to the user's credits (atomic weekly reservation, refunded if the
 * image service fails) — same pattern as app-store-readiness/app-icon.ts.
 */

import { getUserTier } from "@/lib/tier";
import {
  adjustWeeklyCredits,
  getMonthlyCredits,
  getMonthlyLimit,
  getWeeklyLimit,
  reserveWeeklyCredits,
} from "@/lib/credits";
import { recordTokenUsage } from "@/lib/usage";
import { sandboxWriteBinaryFile } from "@/lib/vercel-sandbox";

// Charged at-cost, like the rest of the credit system. Credit unit = one
// Minimax-M3 input token = $0.30 / 1M = $3e-7 (credits.ts: minimax input
// multiplier 0.30/0.30 = 1).
//
// Krea 2 Medium text-to-image is a flat $0.030 per image (no style
// references): $0.030 / $3e-7 = 100,000 credits. This fits the free weekly
// budget (500k), so free users get ~5/week.
export const IMAGE_GENERATION_CREDITS = 100_000;

// Aspect ratios accepted by krea/v2/medium/text-to-image.
export const IMAGE_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:2",
  "16:9",
  "2.35:1",
  "4:5",
  "2:3",
  "9:16",
] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export const MAX_IMAGE_PROMPT_CHARS = 2_000;

const FAL_ENDPOINT = "https://fal.run/krea/v2/medium/text-to-image";
// fal.run is synchronous — it holds the connection until the image is done.
// Generation is usually well under a minute; leave generous headroom while
// staying inside the agent routes' 300s maxDuration.
const FAL_TIMEOUT_MS = 240_000;
// Ceiling on the downloaded image so a misbehaving CDN response can't balloon
// server memory. Krea outputs are a few MB at most.
const MAX_IMAGE_DOWNLOAD_BYTES = 30 * 1024 * 1024;

export type GenerateImageResult =
  | { ok: true; path: string; seed: number | null; creditsCharged: number }
  | { ok: false; error: string; insufficientCredits?: boolean };

/** Normalize + validate the output path. Returns null when unusable. */
function sanitizeOutputPath(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\/+/, "");
  if (!trimmed) return null;
  // No traversal out of the project root, no sneaking into the sandbox's own
  // config — the file must land inside the project tree.
  const segments = trimmed.split("/");
  if (segments.some((s) => s === ".." || s === "" || s === ".")) return null;
  return trimmed;
}

export async function generateImage(opts: {
  projectId: string;
  userId: string;
  prompt: string;
  outputPath: string;
  aspectRatio?: string;
}): Promise<GenerateImageResult> {
  const prompt = opts.prompt.trim();
  if (!prompt) {
    return { ok: false, error: "prompt is required — describe the image to generate." };
  }
  if (prompt.length > MAX_IMAGE_PROMPT_CHARS) {
    return {
      ok: false,
      error: `Keep the image prompt under ${MAX_IMAGE_PROMPT_CHARS} characters.`,
    };
  }

  const outputPath = sanitizeOutputPath(opts.outputPath ?? "");
  if (!outputPath) {
    return {
      ok: false,
      error:
        "outputPath must be a project-relative file path (e.g. public/images/hero.png) without '..' segments.",
    };
  }

  const aspectRatio = (opts.aspectRatio ?? "1:1").trim();
  if (!(IMAGE_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
    return {
      ok: false,
      error: `aspectRatio must be one of: ${IMAGE_ASPECT_RATIOS.join(", ")}.`,
    };
  }

  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { ok: false, error: "Image generation isn't configured on the server." };
  }

  // ── Budget: monthly cap + atomic weekly reservation ──────────────────────
  const tier = await getUserTier(opts.userId);
  // Pre-check the FULL cost against the monthly cap — not merely whether the
  // user is already at it — so someone a credit under the cap can't still
  // incur a whole image's worth of credits.
  if ((await getMonthlyCredits(opts.userId)) + IMAGE_GENERATION_CREDITS > getMonthlyLimit(tier)) {
    return {
      ok: false,
      error: "The user has reached their monthly credit limit — image generation is unavailable until it resets.",
      insufficientCredits: true,
    };
  }
  const reserved = await reserveWeeklyCredits(
    opts.userId,
    IMAGE_GENERATION_CREDITS,
    getWeeklyLimit(tier),
  );
  if (!reserved) {
    return {
      ok: false,
      error: "Not enough weekly credits left to generate an image.",
      insufficientCredits: true,
    };
  }

  const refund = async () => {
    await adjustWeeklyCredits(opts.userId, -IMAGE_GENERATION_CREDITS).catch((err) =>
      // The image failed AND the refund failed — log loudly; the user is owed
      // these credits back.
      console.error(
        "[image-gen] REFUND FAILED — user owed",
        IMAGE_GENERATION_CREDITS,
        "credits:",
        err instanceof Error ? err.message : err,
      ),
    );
  };

  // ── Generate + download (refund the reservation on any failure) ──────────
  let imageBytes: Buffer;
  let seed: number | null = null;
  try {
    const res = await fetch(FAL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt, aspect_ratio: aspectRatio }),
      signal: AbortSignal.timeout(FAL_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`FAL responded ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      images?: Array<{ url?: string }>;
      seed?: number;
    };
    const imageUrl = json.images?.[0]?.url;
    if (!imageUrl) throw new Error("no image URL in FAL response");
    seed = typeof json.seed === "number" ? json.seed : null;

    const download = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
    if (!download.ok) throw new Error(`image download failed (HTTP ${download.status})`);
    imageBytes = Buffer.from(await download.arrayBuffer());
    if (imageBytes.byteLength === 0) throw new Error("downloaded image is empty");
    if (imageBytes.byteLength > MAX_IMAGE_DOWNLOAD_BYTES) {
      throw new Error("downloaded image exceeds the size ceiling");
    }
  } catch (e) {
    await refund();
    console.error("[image-gen] generate failed:", e instanceof Error ? e.message : e);
    return {
      ok: false,
      error:
        "Image generation failed — the image service returned an error. Try again or adjust the prompt.",
    };
  }

  // The image is generated but not yet delivered — a sandbox write failure
  // means the user got nothing, so refund rather than charge for it.
  try {
    await sandboxWriteBinaryFile(opts.projectId, outputPath, imageBytes);
  } catch (e) {
    await refund();
    console.error("[image-gen] sandbox write failed:", e instanceof Error ? e.message : e);
    return {
      ok: false,
      error: `Generated the image but couldn't write it to ${outputPath} in the sandbox. Try again.`,
    };
  }

  // ── Record the charge (monthly DB; the weekly reservation = the real cost) ──
  await recordTokenUsage(opts.userId, "krea-2-medium", 0, 0, IMAGE_GENERATION_CREDITS).catch(
    () => {},
  );

  return { ok: true, path: outputPath, seed, creditsCharged: IMAGE_GENERATION_CREDITS };
}
