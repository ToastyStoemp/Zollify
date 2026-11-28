import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineModule } from '@zollify/sdk';
import { RemoteResolver, type ModuleDescriptor } from '../loader';
import { bundleKey, evictModule, getCached, putCached, sha256Hex } from '../module-cache';

/**
 * A module bundle runs only when it is the one the manifest names. The hash
 * kept beside the cached code is not proof: whoever can rewrite the code can
 * rewrite that hash too.
 */

const GENUINE = 'export default "genuine";';
const FORGED = 'export default "forged";';

/** Stands in for the blob import: the "module" remembers which source it was built from. */
const imported: string[] = [];
const importModule = async (code: string) => {
  imported.push(code);
  return { default: defineModule({ id: 'pos', version: '1.0.0', sdk: '^1.0.0', title: code, setup: () => {} }) };
};

async function descriptor(code = GENUINE): Promise<ModuleDescriptor> {
  return { moduleId: 'pos', version: '1.0.0', url: '/modules/pos/1.0.0/bundle.js', integrity: await sha256Hex(code) };
}

const offline = vi.fn(async (): Promise<string> => {
  throw new Error('Could not download module bundle (offline).');
});

/** Rewrites the cached row the way an attacker with access to this origin's storage would: code and hash together. */
async function forgeCachedRow(): Promise<void> {
  const raw = await new Dexie('zollify_module_cache').open();
  try {
    const key = bundleKey('pos', '1.0.0');
    await raw.table('bundles').update(key, { code: FORGED, integrity: await sha256Hex(FORGED) });
  } finally {
    raw.close();
  }
}

beforeEach(async () => {
  imported.length = 0;
  offline.mockClear();
  await evictModule('pos');
});

describe('a module bundle and the manifest hash', () => {
  it('runs the cached bundle without the network when it is the one the manifest names', async () => {
    const d = await descriptor();
    await putCached({ moduleId: 'pos', version: '1.0.0', code: GENUINE, integrity: d.integrity });

    const definition = await new RemoteResolver(offline, importModule).resolve(d);

    expect(definition.title).toBe(GENUINE);
    expect(offline).not.toHaveBeenCalled();
  });

  it('never runs a download that does not match the manifest, and does not keep it', async () => {
    const d = await descriptor();
    const resolver = new RemoteResolver(async () => FORGED, importModule);

    await expect(resolver.resolve(d)).rejects.toThrow('Integrity check failed');

    expect(imported).toEqual([]);
    expect(await getCached('pos', '1.0.0')).toBeUndefined();
  });

  it('fetches again instead of running a cached bundle rewritten together with its hash', async () => {
    const d = await descriptor();
    await putCached({ moduleId: 'pos', version: '1.0.0', code: GENUINE, integrity: d.integrity });
    await forgeCachedRow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const definition = await new RemoteResolver(async () => GENUINE, importModule).resolve(d);
      expect(definition.title).toBe(GENUINE);
    } finally {
      warn.mockRestore();
    }

    expect(imported).toEqual([GENUINE]);
    expect((await getCached('pos', '1.0.0'))?.code).toBe(GENUINE);
  });

  it('refuses a rewritten cached bundle when it cannot be fetched again', async () => {
    const d = await descriptor();
    await putCached({ moduleId: 'pos', version: '1.0.0', code: GENUINE, integrity: d.integrity });
    await forgeCachedRow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(new RemoteResolver(offline, importModule).resolve(d)).rejects.toThrow('Could not download module bundle');
    } finally {
      warn.mockRestore();
    }

    expect(imported).toEqual([]);
  });

  it('picks up a bundle republished under the same version', async () => {
    await putCached({ moduleId: 'pos', version: '1.0.0', code: GENUINE, integrity: await sha256Hex(GENUINE) });
    const rebuilt = 'export default "rebuilt";';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const definition = await new RemoteResolver(async () => rebuilt, importModule).resolve(await descriptor(rebuilt));
      expect(definition.title).toBe(rebuilt);
    } finally {
      warn.mockRestore();
    }
  });
});
