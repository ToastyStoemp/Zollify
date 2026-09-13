import type { EventBus, EventName, EventPayload, Unsubscribe } from '@boothly/sdk';

type Handler = (payload: unknown) => void;

/**
 * The cross-module event bus.
 *
 * Handlers are isolated: one module throwing inside a `sale` handler must not
 * prevent the next module — or the emitter's own code after `emit` — from
 * running. A module that breaks should degrade itself, not the till.
 */
export class PlatformEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly onError: (name: string, err: unknown) => void;

  constructor(onError?: (name: string, err: unknown) => void) {
    this.onError =
      onError ??
      ((name, err) => {
        console.error(`[boothly] event handler for "${name}" threw`, err);
      });
  }

  on<K extends EventName>(name: K, handler: (payload: EventPayload<K>) => void): Unsubscribe {
    const key = String(name);
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    const h = handler as Handler;
    set.add(h);
    return () => {
      set.delete(h);
      if (set.size === 0) this.handlers.delete(key);
    };
  }

  once<K extends EventName>(name: K, handler: (payload: EventPayload<K>) => void): Unsubscribe {
    const off = this.on(name, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  emit<K extends EventName>(name: K, payload: EventPayload<K>): void {
    const set = this.handlers.get(String(name));
    if (!set || set.size === 0) return;
    // Copy first: a handler may unsubscribe itself (or another) during dispatch.
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        this.onError(String(name), err);
      }
    }
  }

  /** Drops every handler a module registered. Called by the loader on unload. */
  removeAll(handlers: Iterable<Unsubscribe>): void {
    for (const off of handlers) {
      try {
        off();
      } catch {
        /* already detached */
      }
    }
  }

  /** Test/diagnostic helper — how many handlers are attached to a name. */
  countFor(name: EventName): number {
    return this.handlers.get(String(name))?.size ?? 0;
  }
}
