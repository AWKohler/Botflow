/**
 * Client-side HTML → thumbnail rasterizer.
 *
 * Renders an HTML string (the preview snapshot grabbed from the live iframe)
 * in a hidden same-origin iframe and rasterizes the above-the-fold viewport
 * with html2canvas. This restores project thumbnails without any server-side
 * browser: no puppeteer, nothing installed in the sandbox.
 *
 * Adapted from the FigmaCanvas captureViewport flow in
 * src/components/workspace/preview.tsx.
 */
import html2canvas from "html2canvas";

const VIEWPORT = { width: 1440, height: 900 };
const THUMB_WIDTH = 640;

/**
 * Returns a JPEG data URL (640px wide, 16:10) or null on failure. Safe to
 * fire-and-forget — never throws.
 */
export async function renderHtmlThumbnail(html: string): Promise<string | null> {
  if (typeof document === "undefined") return null;

  // Freeze animations/transitions for a clean static capture.
  const frozen = html.includes("</head>")
    ? html.replace(
        "</head>",
        `<style>*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important;}</style></head>`,
      )
    : html;

  const iframe = document.createElement("iframe");
  iframe.style.cssText = `position:fixed;left:-9999px;top:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;border:none;visibility:hidden;`;
  iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
  document.body.appendChild(iframe);

  try {
    await new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
      iframe.srcdoc = frozen;
      // srcdoc load events are reliable, but never hang forever.
      setTimeout(resolve, 5000);
    });
    // Let styles/images settle.
    await new Promise((r) => setTimeout(r, 800));

    const doc = iframe.contentDocument;
    if (!doc?.documentElement) return null;

    const canvas = await html2canvas(doc.documentElement, {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      useCORS: true,
      logging: false,
      imageTimeout: 5000,
      windowWidth: VIEWPORT.width,
      windowHeight: VIEWPORT.height,
    } as Parameters<typeof html2canvas>[1]);

    // Downscale to thumbnail size.
    const thumb = document.createElement("canvas");
    thumb.width = THUMB_WIDTH;
    thumb.height = Math.round((THUMB_WIDTH / VIEWPORT.width) * VIEWPORT.height);
    const ctx = thumb.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL("image/jpeg", 0.82);
  } catch (err) {
    console.warn("[html-thumbnail] capture failed:", err);
    return null;
  } finally {
    iframe.remove();
  }
}
