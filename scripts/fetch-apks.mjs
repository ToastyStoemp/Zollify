/**
 * Pulls the newest Android release from GitHub into the server's APK
 * directory so devices can self-update. Run on the server after each deploy:
 *
 *   ZOLLIFY_GH_TOKEN=<token with repo read> node scripts/fetch-apks.mjs
 *
 * Writes to $ZOLLIFY_APK_DIR (default apps/server/apk). Skips the download
 * when version.json already matches the latest release.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.ZOLLIFY_GH_REPO ?? 'ToastyStoemp/Zollify';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.env.ZOLLIFY_APK_DIR ?? join(root, 'apps', 'server', 'apk'));
const token = process.env.ZOLLIFY_GH_TOKEN;
const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };

const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers });
if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
const releases = await res.json();
const latest = releases.find((r) => r.tag_name?.startsWith('android-') && !r.draft);
if (!latest) throw new Error('No android-* release found.');

const versionAsset = latest.assets.find((a) => a.name === 'version.json');
if (!versionAsset) throw new Error('Release has no version.json');
const download = async (asset) => {
  const r = await fetch(asset.url, { headers: { ...headers, accept: 'application/octet-stream' } });
  if (!r.ok) throw new Error(`Download ${asset.name}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};

const manifest = JSON.parse((await download(versionAsset)).toString('utf-8'));
mkdirSync(outDir, { recursive: true });
const current = existsSync(join(outDir, 'version.json')) ? JSON.parse(readFileSync(join(outDir, 'version.json'), 'utf-8')) : null;
if (current?.versionCode === manifest.versionCode) {
  console.log(`Already at ${manifest.versionName} (${manifest.versionCode}).`);
  process.exit(0);
}
for (const asset of latest.assets.filter((a) => a.name.endsWith('.apk'))) {
  writeFileSync(join(outDir, asset.name), await download(asset));
  console.log(`  ${asset.name}`);
}
writeFileSync(join(outDir, 'version.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Fetched ${latest.tag_name} -> ${outDir}`);
