import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineModule, type ModuleDefinition, type Sdk, type ShellUi } from '@zollify/sdk';
import { ContributionRegistry } from '../contributions';
import { PlatformEventBus } from '../events';
import {
  ModuleLoader,
  orderByDependencies,
  type ModuleDescriptor,
  type ModuleResolver,
} from '../loader';

const ui: ShellUi = { toast: () => {}, confirm: async () => true, saveFile: async () => {}, openDocument: async () => true };

/** Resolver over an in-memory map, standing in for the registry. */
class FakeResolver implements ModuleResolver {
  constructor(private readonly defs: Record<string, ModuleDefinition | Error>) {}
  async resolve(d: ModuleDescriptor): Promise<ModuleDefinition> {
    const entry = this.defs[d.moduleId];
    if (!entry) throw new Error(`unknown module ${d.moduleId}`);
    if (entry instanceof Error) throw entry;
    return entry;
  }
}

function descriptor(moduleId: string, version = '1.0.0'): ModuleDescriptor {
  return { moduleId, version, url: `/m/${moduleId}.js`, integrity: 'x' };
}

function makeLoader(defs: Record<string, ModuleDefinition | Error>) {
  const contributions = new ContributionRegistry();
  const events = new PlatformEventBus(() => {});
  const loader = new ModuleLoader({
    contributions,
    events,
    ui,
    resolver: new FakeResolver(defs),
    sdkVersion: '1.2.0',
  });
  return { loader, contributions, events };
}

const noopSetup = () => {};

describe('ModuleLoader - validation', () => {
  it('refuses a module built against an SDK the host cannot satisfy', async () => {
    const { loader } = makeLoader({
      old: defineModule({ id: 'old', version: '1.0.0', sdk: '^0.9.0', title: 'Old', setup: noopSetup }),
    });

    const [outcome] = await loader.loadAll([descriptor('old')], 'owner');

    expect(outcome?.status).toBe('skipped');
    expect(outcome?.reason).toContain('needs SDK ^0.9.0');
    expect(loader.isLoaded('old')).toBe(false);
  });

  it('refuses a bundle whose declared id differs from the one served', async () => {
    // Guards against a registry mix-up or a swapped bundle mounting under
    // another module's namespace - and therefore its database and HTTP prefix.
    const { loader } = makeLoader({
      pos: defineModule({ id: 'tax', version: '1.0.0', sdk: '^1.0.0', title: 'Tax', setup: noopSetup }),
    });

    const [outcome] = await loader.loadAll([descriptor('pos')], 'owner');

    expect(outcome?.status).toBe('skipped');
    expect(outcome?.reason).toContain('declares id "tax"');
  });

  it('does not load a module above the current role', async () => {
    const { loader } = makeLoader({
      admin: defineModule({
        id: 'admin', version: '1.0.0', sdk: '^1.0.0', title: 'Admin',
        minRole: 'admin', setup: noopSetup,
      }),
    });

    const [outcome] = await loader.loadAll([descriptor('admin')], 'member');

    expect(outcome?.status).toBe('skipped');
    expect(outcome?.reason).toContain('requires role admin');
  });
});

describe('ModuleLoader - isolation', () => {
  it('keeps loading other modules when one throws in setup', async () => {
    // The whole point: a broken Tax module must never stop the till opening.
    const { loader, contributions } = makeLoader({
      pos: defineModule({
        id: 'pos', version: '1.0.0', sdk: '^1.0.0', title: 'POS',
        setup: (sdk: Sdk) => {
          sdk.routes.add({ path: '', name: 'index', component: async () => ({}) as never });
        },
      }),
      tax: defineModule({
        id: 'tax', version: '1.0.0', sdk: '^1.0.0', title: 'Tax',
        setup: () => { throw new Error('boom'); },
      }),
    });

    const outcomes = await loader.loadAll([descriptor('pos'), descriptor('tax')], 'owner');

    expect(outcomes.find((o) => o.moduleId === 'pos')?.status).toBe('loaded');
    expect(outcomes.find((o) => o.moduleId === 'tax')?.status).toBe('failed');
    expect(loader.isLoaded('pos')).toBe(true);
    expect(contributions.routes.map((r) => r.moduleId)).toEqual(['pos']);
  });

  it('rolls back contributions made before setup threw', async () => {
    const { loader, contributions } = makeLoader({
      half: defineModule({
        id: 'half', version: '1.0.0', sdk: '^1.0.0', title: 'Half',
        setup: (sdk: Sdk) => {
          sdk.routes.add({ path: '', name: 'index', component: async () => ({}) as never });
          sdk.nav.add({ routeName: 'index', label: 'Half' });
          throw new Error('failed after registering');
        },
      }),
    });

    await loader.loadAll([descriptor('half')], 'owner');

    expect(contributions.routes).toHaveLength(0);
    expect(contributions.nav).toHaveLength(0);
  });

  it('reclaims routes, nav and event handlers on unload', async () => {
    const { loader, contributions, events } = makeLoader({
      tax: defineModule({
        id: 'tax', version: '1.0.0', sdk: '^1.0.0', title: 'Tax',
        setup: (sdk: Sdk) => {
          sdk.routes.add({ path: '', name: 'index', component: async () => ({}) as never });
          sdk.nav.add({ routeName: 'index', label: 'Tax' });
          sdk.settings.panel({ id: 'tax', label: 'Tax', component: async () => ({}) as never });
          sdk.events.on('sale', () => {});
        },
      }),
    });

    await loader.loadAll([descriptor('tax')], 'owner');
    expect(events.countFor('sale')).toBe(1);

    await loader.unload('tax');

    expect(contributions.routes).toHaveLength(0);
    expect(contributions.nav).toHaveLength(0);
    expect(contributions.settingsPanels).toHaveLength(0);
    // An orphaned handler in a disabled module would be near-impossible to
    // track down later, so unload must take them with it.
    expect(events.countFor('sale')).toBe(0);
  });

  it('calls teardown before disposing the host', async () => {
    const teardown = vi.fn();
    const { loader } = makeLoader({
      pos: defineModule({
        id: 'pos', version: '1.0.0', sdk: '^1.0.0', title: 'POS',
        setup: noopSetup, teardown,
      }),
    });

    await loader.loadAll([descriptor('pos')], 'owner');
    await loader.unload('pos');

    expect(teardown).toHaveBeenCalledOnce();
  });
});

describe('ModuleLoader - dependencies', () => {
  it('skips a module whose requirement is unavailable', async () => {
    const { loader } = makeLoader({
      tax: defineModule({
        id: 'tax', version: '1.0.0', sdk: '^1.0.0', title: 'Tax',
        requires: ['sourcing'], setup: noopSetup,
      }),
    });

    const [outcome] = await loader.loadAll([descriptor('tax')], 'owner');

    expect(outcome?.status).toBe('skipped');
    expect(outcome?.reason).toContain('sourcing');
  });

  it('satisfies requirements the host provides itself', async () => {
    // Core is not a module, so `catalog` has no bundle to load. Without this,
    // every module that depends on core data would be skipped at boot - which
    // is both first-party modules.
    const { loader } = makeLoader({
      pos: defineModule({
        id: 'pos', version: '1.0.0', sdk: '^1.0.0', title: 'POS',
        requires: ['catalog'], setup: noopSetup,
      }),
    });

    const [outcome] = await loader.loadAll([descriptor('pos')], 'owner');

    expect(outcome?.status).toBe('loaded');
    expect(loader.isLoaded('pos')).toBe(true);
  });

  it('unloads dependents before the module they depend on', async () => {
    const order: string[] = [];
    const { loader } = makeLoader({
      base: defineModule({
        id: 'base', version: '1.0.0', sdk: '^1.0.0', title: 'Base',
        setup: noopSetup, teardown: () => { order.push('base'); },
      }),
      leaf: defineModule({
        id: 'leaf', version: '1.0.0', sdk: '^1.0.0', title: 'Leaf',
        requires: ['base'], setup: noopSetup, teardown: () => { order.push('leaf'); },
      }),
    });

    await loader.loadAll([descriptor('base'), descriptor('leaf')], 'owner');
    await loader.unload('base');

    expect(order).toEqual(['leaf', 'base']);
  });
});

describe('orderByDependencies', () => {
  const def = (id: string, requires?: string[]): ModuleDefinition =>
    defineModule({ id, version: '1.0.0', sdk: '*', title: id, requires, setup: noopSetup });

  it('puts dependencies before dependents regardless of input order', () => {
    const map = new Map([
      ['leaf', def('leaf', ['mid'])],
      ['mid', def('mid', ['base'])],
      ['base', def('base')],
    ]);

    const ids = orderByDependencies(map).map((d) => d.id);

    expect(ids.indexOf('base')).toBeLessThan(ids.indexOf('mid'));
    expect(ids.indexOf('mid')).toBeLessThan(ids.indexOf('leaf'));
  });

  it('breaks cycles instead of hanging', () => {
    // A dependency cycle is a packaging mistake; refusing to boot over it would
    // be a far worse outcome than an arbitrary order within the cycle.
    const map = new Map([
      ['a', def('a', ['b'])],
      ['b', def('b', ['a'])],
    ]);

    const ids = orderByDependencies(map).map((d) => d.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set(['a', 'b']));
  });
});
