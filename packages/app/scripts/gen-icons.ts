/**
 * Generate the PWA PNG icons from the source `app/icon.svg`.
 *
 * Android/PWA needs raster icons at fixed sizes, plus a *maskable* variant.
 * Maskable icons are cropped by the launcher to a platform shape (circle,
 * squircle, rounded square), so the important content must sit inside a safe
 * zone: the inner 80% (a ~10% margin on every side). The brand mark bleeds to
 * the SVG edges, so for the maskable version we composite it, scaled down into
 * that safe zone, onto a full-bleed aubergine field. The plain icons keep the
 * mark edge-to-edge as designed.
 *
 * Run once with `npm run gen:icons`; the PNGs are committed. Re-run only when
 * the source mark changes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const publicDir = join(appDir, "public");
const srcSvg = join(appDir, "app", "icon.svg");

// Brand aubergine, matching the shield fill in icon.svg.
const AUBERGINE = "#8e3179";

const svg = readFileSync(srcSvg);

async function plainIcon(size: number, out: string): Promise<void> {
  await sharp(svg, { density: 512 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(publicDir, out));
}

async function maskableIcon(size: number, out: string): Promise<void> {
  // Safe zone: keep the mark within the inner 80% so the launcher's mask crop
  // never clips it. Render the mark at 80% and center it on the aubergine field.
  const inner = Math.round(size * 0.8);
  const mark = await sharp(svg, { density: 512 })
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: AUBERGINE,
    },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toFile(join(publicDir, out));
}

async function main(): Promise<void> {
  await plainIcon(192, "icon-192.png");
  await plainIcon(512, "icon-512.png");
  await maskableIcon(512, "icon-512-maskable.png");
  // Apple touch icon: iOS does not do maskable, and shows the icon on a light
  // or dark tile, so give it the aubergine field too (no transparency).
  await maskableIcon(180, "apple-touch-icon.png");
  console.log("Icons written to packages/app/public/");
}

void main();
