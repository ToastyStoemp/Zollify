/**
 * Renders the launcher icons and splash screens for the Android app from
 * resources/logo.svg (the same mark as the web favicon), so a logo change is
 * one SVG edit plus `node scripts/android-assets.mjs`.
 *
 * Launcher: legacy square + round icons per density, and an adaptive-icon
 * foreground (108dp canvas, mark inside the 66dp safe zone) over the solid
 * background colour. Splash: the mark centred on the app's dark ground, one
 * PNG per density and orientation, sized like Capacitor's own templates.
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'android', 'app', 'src', 'main', 'res');
const svg = readFileSync(join(root, 'resources', 'logo.svg'));
const BG = '#0f172a';

/** The mark only (no square ground) so it can sit on any background. */
const markSvg = svg.toString().replace(/<rect width="136" height="136"[^>]*\/>/, '');
const mark = (px) => sharp(Buffer.from(markSvg)).resize(px, px).png().toBuffer();
const tile = (px) => sharp(svg).resize(px, px).png().toBuffer();

const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

for (const [d, scale] of Object.entries(densities)) {
  const dir = join(res, `mipmap-${d}`);
  mkdirSync(dir, { recursive: true });
  const legacy = Math.round(48 * scale);
  writeFileSync(join(dir, 'ic_launcher.png'), await tile(legacy));
  // Round icons: same tile under a circular mask.
  const r = legacy / 2;
  const circle = Buffer.from(`<svg width="${legacy}" height="${legacy}"><circle cx="${r}" cy="${r}" r="${r}"/></svg>`);
  writeFileSync(join(dir, 'ic_launcher_round.png'), await sharp(await tile(legacy)).composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer());
  // Adaptive foreground: 108dp canvas, mark scaled into the 66dp safe circle.
  const canvas = Math.round(108 * scale);
  // The SVG carries its own padding (mark ~55% of the box), so 84dp lands the mark inside the 66dp safe zone.
  const inner = Math.round(84 * scale);
  writeFileSync(
    join(dir, 'ic_launcher_foreground.png'),
    await sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await mark(inner), gravity: 'centre' }])
      .png()
      .toBuffer(),
  );
}

const splashes = {
  drawable: [480, 320],
  'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800], 'drawable-port-xhdpi': [720, 1280], 'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920],
  'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720], 'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280],
};
for (const [dir, [w, h]] of Object.entries(splashes)) {
  const size = Math.round(Math.min(w, h) * 0.45);
  mkdirSync(join(res, dir), { recursive: true });
  writeFileSync(
    join(res, dir, 'splash.png'),
    await sharp({ create: { width: w, height: h, channels: 3, background: BG } })
      .composite([{ input: await mark(size), gravity: 'centre' }])
      .png()
      .toBuffer(),
  );
}
console.log('Android icons and splash screens written from resources/logo.svg');
