import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The catalogue of client module bundles this server can serve.
 *
 * Bundles are read from disk at boot and hashed once. The hash is published to
 * the client, which refuses to execute anything that doesn't match - so a
 * corrupted or swapped file on the server is caught in the browser rather than
 * silently run.
 */

export interface PublishedModule {
  moduleId: string;
  version: string;
  title: string;
  description?: string;
  /** Minimum role, mirrored from the bundle manifest so the server can filter too. */
  minRole?: 'owner' | 'admin' | 'member';
  requires?: string[];
  integrity: string;
  /** Path relative to the API base, e.g. `/modules/pos/1.0.0/bundle.js`. */
  url: string;
  /** Absolute path on disk. Never sent to clients. */
  filePath: string;
  sizeBytes: number;
}

export interface ModuleManifestFile {
  moduleId: string;
  version: string;
  title: string;
  description?: string;
  minRole?: 'owner' | 'admin' | 'member';
  requires?: string[];
  bundle: string;
}

function sha256File(path: string): { hex: string; size: number } {
  const buf = readFileSync(path);
  return { hex: createHash('sha256').update(buf).digest('hex'), size: buf.byteLength };
}

/**
 * Scans `<storeDir>/<moduleId>/<version>/manifest.json`. A malformed entry is
 * skipped with a warning rather than aborting boot - one bad module directory
 * must not take the whole server down.
 */
export function loadModuleStore(storeDir: string): Map<string, PublishedModule> {
  const found = new Map<string, PublishedModule>();
  if (!existsSync(storeDir)) return found;

  for (const moduleId of readdirSync(storeDir, { withFileTypes: true })) {
    if (!moduleId.isDirectory()) continue;
    const moduleDir = join(storeDir, moduleId.name);

    for (const version of readdirSync(moduleDir, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      const dir = join(moduleDir, version.name);
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ModuleManifestFile;
        const bundlePath = join(dir, manifest.bundle);
        if (!existsSync(bundlePath)) {
          console.warn(`[zollify] ${manifestPath} points at a missing bundle; skipping`);
          continue;
        }
        const { hex, size } = sha256File(bundlePath);
        const existing = found.get(manifest.moduleId);
        // Newest version wins; the store may hold older ones for rollback.
        if (existing && compareVersionStrings(existing.version, manifest.version) >= 0) continue;

        found.set(manifest.moduleId, {
          moduleId: manifest.moduleId,
          version: manifest.version,
          title: manifest.title,
          description: manifest.description,
          minRole: manifest.minRole,
          requires: manifest.requires,
          integrity: hex,
          url: `/modules/${manifest.moduleId}/${manifest.version}/${manifest.bundle}`,
          filePath: bundlePath,
          sizeBytes: size,
        });
      } catch (err) {
        console.warn(`[zollify] unreadable module manifest at ${manifestPath}`, err);
      }
    }
  }

  return found;
}

function compareVersionStrings(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** What the client loader needs, with server-only fields stripped. */
export function toDescriptor(m: PublishedModule): {
  moduleId: string;
  version: string;
  url: string;
  integrity: string;
  title: string;
  description?: string;
  requires?: string[];
} {
  return {
    moduleId: m.moduleId,
    version: m.version,
    url: m.url,
    integrity: m.integrity,
    title: m.title,
    description: m.description,
    requires: m.requires,
  };
}
