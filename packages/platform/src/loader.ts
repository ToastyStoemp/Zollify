import {
  SDK_VERSION,
  roleAtLeast,
  satisfies,
  type ModuleDefinition,
  type Role,
} from '@zollify/sdk';
import type { ContributionRegistry } from './contributions';
import type { PlatformEventBus } from './events';
import { createModuleHost, type ModuleHost } from './sdk-host';
import { getCached, putCached, verifyCached } from './module-cache';

/** What the registry advertises for one module. */
export interface ModuleDescriptor {
  moduleId: string;
  version: string;
  /** URL the bundle is fetched from on install. Relative to the API base. */
  url: string;
  /** Lowercase hex SHA-256 the downloaded bundle must match. */
  integrity: string;
}

/**
 * How a module's code is obtained. Two implementations exist: one resolving
 * from the app's own build (used in development and for first-party modules
 * shipped with the shell) and one resolving from the registry + cache. Keeping
 * both behind this interface is what let the runtime path be switched on
 * without rewriting the loader.
 */
export interface ModuleResolver {
  resolve(descriptor: ModuleDescriptor): Promise<ModuleDefinition>;
}

export type LoadStatus = 'loaded' | 'failed' | 'skipped';

export interface LoadOutcome {
  moduleId: string;
  version: string;
  status: LoadStatus;
  reason?: string;
}

interface LoadedModule {
  definition: ModuleDefinition;
  host: ModuleHost;
  version: string;
}

export interface LoaderOptions {
  contributions: ContributionRegistry;
  events: PlatformEventBus;
  resolver: ModuleResolver;
  ui: import('@zollify/sdk').ShellUi;
  sdkVersion?: string;
  /**
   * Capabilities the host itself provides, which a module may name in
   * `requires` without a module supplying them. Core is not a module — it is
   * always present — so `catalog` and `events` resolve here rather than
   * causing every module that depends on them to be skipped.
   */
  provided?: string[];
}

/**
 * Loads, orders and unloads runtime modules.
 *
 * Three rules shape this: a module that fails must not stop the others (a
 * broken Tax module cannot prevent the till from opening), dependencies load
 * before dependents, and everything a module registered is reclaimed on
 * unload.
 */
export class ModuleLoader {
  private readonly loaded = new Map<string, LoadedModule>();
  private readonly opts: LoaderOptions;
  private readonly sdkVersion: string;
  private readonly provided: Set<string>;

  constructor(opts: LoaderOptions) {
    this.opts = opts;
    this.sdkVersion = opts.sdkVersion ?? SDK_VERSION;
    this.provided = new Set(opts.provided ?? ['catalog', 'events']);
  }

  isLoaded(moduleId: string): boolean {
    return this.loaded.has(moduleId);
  }

  list(): { moduleId: string; version: string; title: string }[] {
    return [...this.loaded.values()].map((m) => ({
      moduleId: m.definition.id,
      version: m.version,
      title: m.definition.title,
    }));
  }

  /**
   * Loads a set of modules for a role. Returns one outcome per descriptor —
   * callers surface failures rather than the loader throwing, because partial
   * success is the normal, acceptable result.
   */
  async loadAll(descriptors: ModuleDescriptor[], role: Role): Promise<LoadOutcome[]> {
    const outcomes: LoadOutcome[] = [];
    const resolved = new Map<string, ModuleDefinition>();

    // Resolve everything first so dependency ordering can see the whole set.
    for (const descriptor of descriptors) {
      if (this.loaded.has(descriptor.moduleId)) continue;
      try {
        const definition = await this.opts.resolver.resolve(descriptor);
        const problem = this.validate(descriptor, definition, role);
        if (problem) {
          outcomes.push({ ...descriptorRef(descriptor), status: 'skipped', reason: problem });
          continue;
        }
        resolved.set(definition.id, definition);
      } catch (err) {
        outcomes.push({
          ...descriptorRef(descriptor),
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const satisfied = (id: string): boolean => this.provided.has(id) || this.loaded.has(id);

    for (const definition of orderByDependencies(resolved, satisfied)) {
      const descriptor = descriptors.find((d) => d.moduleId === definition.id);
      const version = descriptor?.version ?? definition.version;

      const missing = (definition.requires ?? []).filter(
        (dep) => !this.provided.has(dep) && !this.loaded.has(dep) && !resolved.has(dep),
      );
      if (missing.length) {
        outcomes.push({
          moduleId: definition.id,
          version,
          status: 'skipped',
          reason: `requires module(s) not available: ${missing.join(', ')}`,
        });
        continue;
      }

      try {
        await this.mount(definition, version);
        outcomes.push({ moduleId: definition.id, version, status: 'loaded' });
      } catch (err) {
        outcomes.push({
          moduleId: definition.id,
          version,
          status: 'failed',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return outcomes;
  }

  private validate(
    descriptor: ModuleDescriptor,
    definition: ModuleDefinition,
    role: Role,
  ): string | null {
    if (definition.id !== descriptor.moduleId) {
      return `bundle declares id "${definition.id}" but the registry served it as "${descriptor.moduleId}"`;
    }
    if (!satisfies(this.sdkVersion, definition.sdk)) {
      return `needs SDK ${definition.sdk}, host provides ${this.sdkVersion}`;
    }
    if (definition.minRole && !roleAtLeast(role, definition.minRole)) {
      return `requires role ${definition.minRole}`;
    }
    return null;
  }

  private async mount(definition: ModuleDefinition, version: string): Promise<void> {
    const host = createModuleHost(definition.id, {
      contributions: this.opts.contributions,
      events: this.opts.events,
      ui: this.opts.ui,
    });

    try {
      await definition.setup(host.sdk);
    } catch (err) {
      // Roll back anything setup() managed to register before throwing, so a
      // failed module leaves no half-registered routes or handlers behind.
      await host.dispose();
      throw err;
    }

    this.loaded.set(definition.id, { definition, host, version });
  }

  /** Unloads a module and everything it contributed. Dependents are unloaded first. */
  async unload(moduleId: string): Promise<void> {
    for (const [id, mod] of this.loaded) {
      if (id !== moduleId && (mod.definition.requires ?? []).includes(moduleId)) {
        await this.unload(id);
      }
    }

    const mod = this.loaded.get(moduleId);
    if (!mod) return;
    this.loaded.delete(moduleId);

    try {
      await mod.definition.teardown?.();
    } catch (err) {
      console.error(`[zollify] teardown of "${moduleId}" threw`, err);
    }
    await mod.host.dispose();
    removeModuleStyles(moduleId);
  }

  async unloadAll(): Promise<void> {
    for (const id of [...this.loaded.keys()]) await this.unload(id);
  }
}

/**
 * Drops the <style> a module's bundle injected on import. Without this, styles
 * accumulate across enable/disable cycles and a disabled module keeps quietly
 * restyling the shell.
 */
function removeModuleStyles(moduleId: string): void {
  if (typeof document === 'undefined') return;
  for (const el of document.querySelectorAll(`style[data-zollify-module="${moduleId}"]`)) {
    el.remove();
  }
}

function descriptorRef(d: ModuleDescriptor): { moduleId: string; version: string } {
  return { moduleId: d.moduleId, version: d.version };
}

/**
 * Depth-first topological order so a dependency is always mounted before the
 * module that declared it. Cycles are broken rather than thrown on: the module
 * still loads, just in an arbitrary order within the cycle, which is a far
 * better failure mode than refusing to boot.
 */
export function orderByDependencies(
  modules: Map<string, ModuleDefinition>,
  alreadyLoaded: (id: string) => boolean = () => false,
): ModuleDefinition[] {
  const ordered: ModuleDefinition[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string): void => {
    if (state.get(id) === 'done' || state.get(id) === 'visiting') return;
    const def = modules.get(id);
    if (!def) return;
    state.set(id, 'visiting');
    for (const dep of def.requires ?? []) {
      if (!alreadyLoaded(dep)) visit(dep);
    }
    state.set(id, 'done');
    ordered.push(def);
  };

  for (const id of modules.keys()) visit(id);
  return ordered;
}

// ── Resolvers ───────────────────────────────────────────────────────────────

/**
 * Resolves modules bundled with the shell. Used in development and for
 * first-party modules that ship in the app build — the same loader path, minus
 * the network.
 */
export class StaticResolver implements ModuleResolver {
  constructor(private readonly registry: Record<string, () => Promise<unknown>>) {}

  async resolve(descriptor: ModuleDescriptor): Promise<ModuleDefinition> {
    const load = this.registry[descriptor.moduleId];
    if (!load) throw new Error(`no bundled module registered as "${descriptor.moduleId}"`);
    return asDefinition(await load(), descriptor.moduleId);
  }
}

/**
 * Resolves modules from the registry, via the offline cache.
 *
 * The cache is consulted first and the network is only reached when a version
 * is genuinely absent — that is what lets a booth with no signal boot every
 * module it already has.
 */
export class RemoteResolver implements ModuleResolver {
  constructor(
    private readonly fetchBundle: (url: string) => Promise<string>,
    private readonly importModule: (code: string) => Promise<unknown> = importFromBlob,
  ) {}

  async resolve(descriptor: ModuleDescriptor): Promise<ModuleDefinition> {
    let entry = await getCached(descriptor.moduleId, descriptor.version);

    if (entry && !(await verifyCached(entry))) {
      // Stored bytes no longer match the published hash — treat as absent and
      // re-fetch rather than executing something we can't vouch for.
      entry = undefined;
    }

    if (!entry) {
      const code = await this.fetchBundle(descriptor.url);
      entry = await putCached({
        moduleId: descriptor.moduleId,
        version: descriptor.version,
        code,
        integrity: descriptor.integrity,
      });
    }

    return asDefinition(await this.importModule(entry.code), descriptor.moduleId);
  }
}

/**
 * Executes bundle source as an ES module. A blob URL is used rather than `eval`
 * so the code gets a real module scope and static `import` of host externals
 * resolves through the import map the shell installs.
 */
async function importFromBlob(code: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function asDefinition(mod: unknown, moduleId: string): ModuleDefinition {
  const candidate = (mod as { default?: unknown } | null)?.default;
  if (!isModuleDefinition(candidate)) {
    throw new Error(
      `"${moduleId}" did not default-export a defineModule() result — got ${describe(candidate)}`,
    );
  }
  return candidate;
}

function isModuleDefinition(value: unknown): value is ModuleDefinition {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ModuleDefinition>;
  return (
    typeof v.id === 'string' &&
    typeof v.version === 'string' &&
    typeof v.sdk === 'string' &&
    typeof v.title === 'string' &&
    typeof v.setup === 'function'
  );
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return typeof value;
}
