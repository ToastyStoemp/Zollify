import { createApp, h, nextTick, type Component } from 'vue';

/**
 * Mounts a component into the document, enough for these few tests without a
 * test-utils dependency. `render` is the parent's render function, so a test
 * can flip a ref and have the component come and go.
 */
export async function mount(render: () => ReturnType<typeof h> | null): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({ render } as Component);
  app.mount(host);
  await settle();
  return {
    host,
    unmount: () => {
      app.unmount();
      host.remove();
    },
  };
}

/** Lets watchers, onMounted's own nextTick and pending promises run. */
export async function settle(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

export function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}
