import { reactive } from 'vue';
import type { NavItem, Role, RouteDef, SettingsPanel } from '@zollify/sdk';
import { roleAtLeast } from '@zollify/sdk';

export interface OwnedRoute extends RouteDef {
  moduleId: string;
  /** Absolute path the shell registers: `/m/<moduleId>/<path>`. */
  fullPath: string;
}
export interface OwnedNavItem extends NavItem {
  moduleId: string;
}
export interface OwnedSettingsPanel extends SettingsPanel {
  moduleId: string;
}

/** Notified the moment a route is contributed or withdrawn. */
export interface RouteSink {
  add(route: OwnedRoute): void;
  remove(routeName: string): void;
}

/**
 * Everything modules have contributed to the shell, tracked by owner so a
 * module can be unloaded cleanly. Reactive so the nav and settings index
 * re-render the moment a module is enabled or disabled — no reload.
 */
export class ContributionRegistry {
  readonly routes = reactive<OwnedRoute[]>([]);
  readonly nav = reactive<OwnedNavItem[]>([]);
  readonly settingsPanels = reactive<OwnedSettingsPanel[]>([]);

  private sink: RouteSink | null = null;

  /**
   * Wires the router in so a contributed route reaches it immediately.
   *
   * Registering routes in a second pass after loading looks equivalent but is
   * not: `nav` is reactive, so the sidebar can render a <router-link> for a
   * route the router has not been told about yet, and resolving that link
   * throws. Pushing each route through as it arrives removes the window.
   */
  setRouteSink(sink: RouteSink | null): void {
    this.sink = sink;
    if (sink) for (const route of this.routes) sink.add(route);
  }

  /** Mount point for a module's routes. Namespacing prevents collisions and path squatting. */
  static mountPath(moduleId: string, path: string): string {
    const tail = path.replace(/^\/+/, '');
    return tail ? `/m/${moduleId}/${tail}` : `/m/${moduleId}`;
  }

  addRoute(moduleId: string, route: RouteDef): OwnedRoute {
    const name = qualifiedName(moduleId, route.name);
    if (this.routes.some((r) => r.name === name)) {
      throw new Error(`Module "${moduleId}" registered route name "${route.name}" twice.`);
    }
    const owned: OwnedRoute = {
      ...route,
      name,
      moduleId,
      fullPath: ContributionRegistry.mountPath(moduleId, route.path),
    };
    // Into the router first, then into the reactive list the nav reads.
    this.sink?.add(owned);
    this.routes.push(owned);
    return owned;
  }

  addNav(moduleId: string, item: NavItem): void {
    this.nav.push({ ...item, moduleId, routeName: qualifiedName(moduleId, item.routeName) });
  }

  addSettingsPanel(moduleId: string, panel: SettingsPanel): void {
    this.settingsPanels.push({ ...panel, moduleId, id: `${moduleId}.${panel.id}` });
  }

  /** Removes every contribution a module made. */
  removeModule(moduleId: string): void {
    for (const route of this.routes) {
      if (route.moduleId === moduleId) this.sink?.remove(route.name);
    }
    spliceWhere(this.routes, (r) => r.moduleId === moduleId);
    spliceWhere(this.nav, (n) => n.moduleId === moduleId);
    spliceWhere(this.settingsPanels, (p) => p.moduleId === moduleId);
  }

  /**
   * Nav visible to a role, in order. Role filtering happens here as well as in
   * the router guard — hiding a link is courtesy, refusing the route is the
   * control, and the server refusing the data is the guarantee.
   */
  navFor(role: Role): OwnedNavItem[] {
    return this.nav
      .filter((item) => !item.minRole || roleAtLeast(role, item.minRole))
      .slice()
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
  }

  settingsFor(role: Role): OwnedSettingsPanel[] {
    return this.settingsPanels
      .filter((p) => !p.minRole || roleAtLeast(role, p.minRole))
      .slice()
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
  }
}

/** Route names are namespaced so two modules can't fight over one name. */
export function qualifiedName(moduleId: string, name: string): string {
  return `${moduleId}:${name}`;
}

function spliceWhere<T>(arr: T[], pred: (item: T) => boolean): void {
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (item !== undefined && pred(item)) arr.splice(i, 1);
  }
}
