import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');

const framePath = path.join(root, 'public', 'iphone_17_pro.png');
const screenshotPath = path.join(root, 'public', 'bento', 'swift-auth-ss.jpeg');
const outputPath = path.join(root, 'public', 'bento', 'swift-app-auth.png');

// Pixel-perfect display opening measured from the 1350 × 2760 frame asset.
const screen = { left: 72, top: 69, width: 1206, height: 2622 };

const { data: screenshot, info } = await sharp(screenshotPath)
  .resize(screen.width, screen.height, { fit: 'fill' })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const frameAlpha = await sharp(framePath)
  .extractChannel(3)
  .extract(screen)
  .raw()
  .toBuffer();

// The frame's transparent display opening is connected from its center. Flood
// fill that opening so transparent pixels outside the phone's rounded corners
// are not mistaken for display pixels.
const pixelCount = screen.width * screen.height;
const displayMask = new Uint8Array(pixelCount);
const start = Math.floor(screen.height / 2) * screen.width + Math.floor(screen.width / 2);
const stack = [start];
displayMask[start] = 1;

while (stack.length > 0) {
  const pixel = stack.pop();
  if (pixel === undefined) break;

  const x = pixel % screen.width;
  const neighbors = [
    pixel - screen.width,
    pixel + screen.width,
    x > 0 ? pixel - 1 : -1,
    x < screen.width - 1 ? pixel + 1 : -1,
  ];

  for (const neighbor of neighbors) {
    if (
      neighbor >= 0 &&
      neighbor < pixelCount &&
      displayMask[neighbor] === 0 &&
      frameAlpha[neighbor] < 128
    ) {
      displayMask[neighbor] = 1;
      stack.push(neighbor);
    }
  }
}

for (let pixel = 0; pixel < pixelCount; pixel += 1) {
  const alpha = displayMask[pixel] ? 255 - frameAlpha[pixel] : 0;
  screenshot[pixel * 4 + 3] = Math.round((screenshot[pixel * 4 + 3] * alpha) / 255);
}

const clippedScreenshot = await sharp(screenshot, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .png()
  .toBuffer();

const composite = await sharp({
  create: {
    width: 1350,
    height: 2760,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([
    { input: clippedScreenshot, left: screen.left, top: screen.top },
    { input: framePath, left: 0, top: 0 },
  ])
  .png()
  .toBuffer();

await sharp(composite)
  .resize({ width: 700 })
  .png()
  .toFile(outputPath);

console.log(`Created ${path.relative(root, outputPath)}`);
