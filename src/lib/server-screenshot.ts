/**
 * Server-side Chromium screenshot/rasterization (Vercel compute).
 *
 * Revived from the pre-sandbox thumbnail infrastructure (removed in 904b03c,
 * design notes in future/thumbnail-and-preview-snapshot.md): puppeteer-core
 * driven by @sparticuz/chromium on Vercel, a local Chrome install in dev, and
 * a drawn placeholder (native `canvas`, lazy-imported) when no browser exists.
 *
 * Used by POST /api/projects/[id]/snapshot to rasterize the captured preview
 * HTML into the project thumbnail — replacing the client-side html2canvas
 * path, which never rendered reliably.
 */
import fs from "fs";
import type { Browser } from "puppeteer-core";

// Thumbnail geometry: 16:10, matching the old html2canvas output that project
// cards were designed around.
export const THUMB_VIEWPORT = { width: 1280, height: 800 };
export const THUMB_WIDTH = 640;

const isProduction = process.env.NODE_ENV === "production" && process.env.VERCEL;

// Local dev renders with an installed Chrome — common install locations.
const localChromePaths = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", // macOS
  "/Applications/Chromium.app/Contents/MacOS/Chromium", // macOS Chromium
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", // macOS Brave
  "/Applications/Arc.app/Contents/MacOS/Arc", // macOS Arc
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", // macOS Edge
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", // Windows
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", // Windows x86
  "/usr/bin/google-chrome", // Linux
  "/usr/bin/chromium-browser", // Linux
];

function findLocalChrome(): string | null {
  for (const path of localChromePaths) {
    try {
      if (fs.existsSync(path)) return path;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Launch headless Chromium: @sparticuz/chromium on Vercel, local Chrome in
 * dev. Returns null in dev when no Chrome is installed (callers fall back to
 * a placeholder).
 */
export async function launchScreenshotBrowser(): Promise<Browser | null> {
  const puppeteer = (await import("puppeteer-core")).default;
  if (isProduction) {
    const chromium = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }
  const chromePath = findLocalChrome();
  if (!chromePath) return null;
  return puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

/**
 * Render an HTML string (a self-contained preview snapshot: scripts stripped,
 * styles + images inlined by the injected runtime's serializer) to a JPEG
 * thumbnail buffer. Returns null when rendering isn't possible; never throws
 * for browser-level failures the caller can't act on.
 */
export async function renderHtmlToThumbnail(html: string): Promise<Buffer | null> {
  let browser: Browser | null = null;
  try {
    browser = await launchScreenshotBrowser();
    if (!browser) {
      console.warn("[server-screenshot] no Chrome found — drawing placeholder");
      return drawPlaceholder();
    }
    const page = await browser.newPage();
    await page.setViewport({ ...THUMB_VIEWPORT, deviceScaleFactor: 1 });
    // 'load' is the strongest waitUntil setContent supports; the snapshot has
    // no scripts and mostly-inlined assets, so it settles fast.
    await page.setContent(html, { waitUntil: "load", timeout: 10_000 });
    // Let fonts/late images paint.
    await new Promise((r) => setTimeout(r, 500));
    const png = Buffer.from(
      await page.screenshot({ type: "png", fullPage: false }),
    );
    return await downscaleToJpeg(png);
  } catch (err) {
    console.error("[server-screenshot] render failed:", err);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Downscale a full-viewport PNG to the stored thumbnail JPEG via sharp. */
async function downscaleToJpeg(png: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(png)
    .resize(THUMB_WIDTH, Math.round((THUMB_WIDTH / THUMB_VIEWPORT.width) * THUMB_VIEWPORT.height))
    .jpeg({ quality: 82 })
    .toBuffer();
}

/**
 * Dev-only placeholder when no local Chrome exists. Lazy-imports the native
 * `canvas` binding so the Vercel build never tries to bundle it.
 */
async function drawPlaceholder(): Promise<Buffer | null> {
  try {
    const { createCanvas } = await import("canvas");
    const el = createCanvas(THUMB_VIEWPORT.width, THUMB_VIEWPORT.height);
    const ctx = el.getContext("2d");
    ctx.fillStyle = "#f3f4f6";
    ctx.fillRect(0, 0, THUMB_VIEWPORT.width, THUMB_VIEWPORT.height);
    ctx.fillStyle = "#6b7280";
    ctx.font = "48px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Screenshot Preview", THUMB_VIEWPORT.width / 2, 380);
    ctx.font = "24px Arial";
    ctx.fillText("Install Chrome to capture real screenshots", THUMB_VIEWPORT.width / 2, 440);
    return await downscaleToJpeg(el.toBuffer("image/png"));
  } catch (err) {
    console.warn("[server-screenshot] placeholder draw failed:", err);
    return null;
  }
}
