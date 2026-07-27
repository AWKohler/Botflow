/**
 * Swift project thumbnail compositor.
 *
 * Takes a raw simulator screengrab (the frame the browser pulls off the
 * stream canvas every ~30s) and produces a 1280×800 project thumbnail:
 * the screengrab is placed inside the device bezel mockup (the same assets
 * DeviceFrame renders in the workspace), centered on a background derived
 * from the screengrab itself — blurred and darkened, so the portrait frame
 * sits naturally in the 16:10 card without letterboxing.
 *
 * Pure sharp; no browser involved.
 */
import path from "path";

// Must match src/components/persistent-workspace/device-frame.tsx GEOMETRY —
// bezel asset dimensions and the screen content rect within them.
const DEVICES = {
  iphone: {
    asset: "iphone_17_pro.png",
    box: { w: 1350, h: 2760 },
    screen: { x: 72, y: 69, w: 1206, h: 2622 },
    radius: 130,
    // PNG has a transparent screen hole → screenshot goes UNDER the bezel.
    screenInFront: false,
  },
  ipad: {
    asset: "ipad_pro.svg",
    box: { w: 776, h: 595 },
    screen: { x: (776 - 719.06) / 2, y: (595 - 538.211) / 2, w: 719.06, h: 538.211 },
    radius: 16.65,
    // SVG draws a solid switched-off screen → screenshot goes ON TOP.
    screenInFront: true,
  },
} as const;

export type SwiftThumbnailDevice = keyof typeof DEVICES;

const CANVAS = { w: 1280, h: 800 }; // 16:10, same as web project thumbnails
const DEVICE_MARGIN = 40; // breathing room above/below the bezel

/**
 * Composite a simulator screengrab into a project thumbnail JPEG.
 * Returns null on any processing failure — thumbnails are cosmetic and must
 * never fail the screengrab upload they piggyback on.
 */
export async function composeSwiftThumbnail(
  screengrab: Buffer,
  device: SwiftThumbnailDevice,
): Promise<Buffer | null> {
  try {
    const sharp = (await import("sharp")).default;
    const g = DEVICES[device];
    const assetPath = path.join(process.cwd(), "public", g.asset);

    // Scale the bezel to fill the canvas height minus margins (portrait
    // iPhone) — or, for the landscape iPad box, whichever axis binds.
    const scale = Math.min(
      (CANVAS.h - DEVICE_MARGIN * 2) / g.box.h,
      (CANVAS.w - DEVICE_MARGIN * 2) / g.box.w,
    );
    const dev = { w: Math.round(g.box.w * scale), h: Math.round(g.box.h * scale) };
    const devX = Math.round((CANVAS.w - dev.w) / 2);
    const devY = Math.round((CANVAS.h - dev.h) / 2);
    const scr = {
      x: Math.round(g.screen.x * scale),
      y: Math.round(g.screen.y * scale),
      w: Math.round(g.screen.w * scale),
      h: Math.round(g.screen.h * scale),
    };

    // Background: the screengrab itself, cover-scaled up, heavily blurred and
    // dimmed — a UI-derived backdrop that always harmonizes with the app.
    const background = await sharp(screengrab)
      .resize(CANVAS.w, CANVAS.h, { fit: "cover" })
      .blur(36)
      .modulate({ brightness: 0.55, saturation: 1.15 })
      .toBuffer();

    // Bezel rasterized at the target size (density up-samples the iPad SVG so
    // it stays crisp instead of scaling the tiny default raster).
    const bezel = await sharp(assetPath, { density: 300 })
      .resize(dev.w, dev.h, { fit: "fill" })
      .png()
      .toBuffer();

    // Screengrab cover-fitted to the screen rect, corners rounded to the
    // scaled screen radius (matters for the iPad, whose screenshot sits on
    // top of the bezel; for the iPhone the opaque bezel covers the corners,
    // but rounding is harmless and guards against edge antialiasing leaks).
    const radius = Math.max(1, Math.round(g.radius * scale));
    const cornerMask = Buffer.from(
      `<svg width="${scr.w}" height="${scr.h}"><rect x="0" y="0" width="${scr.w}" height="${scr.h}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
    );
    const screen = await sharp(screengrab)
      .resize(scr.w, scr.h, { fit: "cover" })
      .composite([{ input: cornerMask, blend: "dest-in" }])
      .png()
      .toBuffer();

    const screenLayer = { input: screen, left: devX + scr.x, top: devY + scr.y };
    const bezelLayer = { input: bezel, left: devX, top: devY };

    return await sharp(background)
      .composite(g.screenInFront ? [bezelLayer, screenLayer] : [screenLayer, bezelLayer])
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (err) {
    console.error("[swift-thumbnail] compose failed:", err);
    return null;
  }
}
