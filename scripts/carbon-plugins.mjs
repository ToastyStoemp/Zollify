#!/usr/bin/env node
/**
 * Writes the carbon flavour's own capacitor.plugins.json, without the plugins
 * android/app/build.gradle strips from the carbon APK.
 *
 * `npx cap sync` writes one plugin list for every flavour
 * (app/src/main/assets/capacitor.plugins.json). Capacitor loads that list with
 * Class.forName and gives up on the WHOLE list at the first class it cannot
 * find - so the Bluetooth plugin missing from the carbon APK took @capacitor/app
 * and @capgo/capacitor-updater down with it: no content updates on a Carbon,
 * ever. A flavour's own asset wins over main's, so carbon gets this filtered copy.
 *
 * Runs after `npx cap sync android` (see the android:sync script). Keep
 * CARBON_EXCLUDED in step with the exclusions in android/app/build.gradle.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'android/app/src/main/assets/capacitor.plugins.json');
const target = join(root, 'android/app/src/carbon/assets/capacitor.plugins.json');

/** npm packages whose native module build.gradle excludes from the carbon variant. */
export const CARBON_EXCLUDED = ['@capacitor-community/bluetooth-le'];

export function carbonPlugins(list) {
  return list.filter((p) => !CARBON_EXCLUDED.includes(p.pkg));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(source)) {
    console.error(`No ${source} - run \`npx cap sync android\` first.`);
    process.exit(1);
  }
  const all = JSON.parse(readFileSync(source, 'utf8'));
  const kept = carbonPlugins(all);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(kept, null, '\t')}\n`);
  console.log(`carbon plugins: ${kept.map((p) => p.pkg).join(', ')} (left out: ${all.length - kept.length})`);
}
