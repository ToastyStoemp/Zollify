// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, ref } from 'vue';
import { DialogHeading, DialogLayer, DialogPanel } from '../dialog';
import ModalShell from '../ModalShell.vue';
import { mount, press, settle } from './mount';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

/** A page with an opener button and, while `open` is true, a modal holding the given fields. */
async function page(fields: () => ReturnType<typeof h>[], onClose = vi.fn()) {
  const open = ref(false);
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  const mounted = await mount(() =>
    open.value ? h(ModalShell, { title: 'Edit product', onClose }, { default: fields, footer: () => h('button', { id: 'save' }, 'Save') }) : null,
  );
  cleanups.push(mounted.unmount, () => opener.remove());
  const show = async (from: HTMLElement = opener): Promise<void> => {
    from.focus();
    open.value = true;
    await settle();
  };
  const hide = async (): Promise<void> => {
    open.value = false;
    await settle();
  };
  return { opener, onClose, show, hide, host: mounted.host };
}

const twoFields = () => [h('input', { id: 'title' }), h('input', { id: 'price' })];
const activeId = () => (document.activeElement as HTMLElement | null)?.id;

describe('ModalShell focus', () => {
  it('focuses the first field on opening, not the close button', async () => {
    const { show } = await page(twoFields);
    await show();
    expect(activeId()).toBe('title');
  });

  it('wraps Tab from the last stop to the first, and Shift+Tab back', async () => {
    const { show, host } = await page(twoFields);
    await show();

    host.querySelector<HTMLElement>('#save')!.focus();
    const forward = press('Tab');
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('.close'));

    const back = press('Tab', { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(activeId()).toBe('save');
  });

  it('leaves Tab alone between stops inside the dialog', async () => {
    const { show } = await page(twoFields);
    await show();
    expect(press('Tab').defaultPrevented).toBe(false);
  });

  it('pulls focus back in when it lands on the page behind', async () => {
    const { show, opener } = await page(twoFields);
    await show();

    opener.focus();

    expect(activeId()).toBe('title');
  });

  it('closes on Escape even when focus is not inside it', async () => {
    const { show, onClose } = await page(twoFields);
    await show();
    (document.activeElement as HTMLElement).blur();

    press('Escape');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the opener on closing', async () => {
    const { show, hide, opener } = await page(twoFields);
    await show();
    expect(document.activeElement).not.toBe(opener);
    await hide();
    expect(document.activeElement).toBe(opener);
  });

  it('locks page scroll while open and puts it back after', async () => {
    const { show, hide } = await page(twoFields);
    document.body.style.overflow = 'auto';
    await show();
    expect(document.body.style.overflow).toBe('hidden');
    await hide();
    expect(document.body.style.overflow).toBe('auto');
    document.body.style.overflow = '';
  });

  it('gives Escape to the top dialog only when two are open', async () => {
    const below = await page(twoFields);
    await below.show();
    const above = await page(() => [h('input', { id: 'confirm' })]);
    // Opened from a button inside the first one, as a confirmation is.
    const saveBelow = below.host.querySelector<HTMLElement>('#save')!;
    await above.show(saveBelow);

    press('Escape');
    expect(above.onClose).toHaveBeenCalledTimes(1);
    expect(below.onClose).not.toHaveBeenCalled();

    await above.hide();
    expect(document.activeElement).toBe(saveBelow);
    press('Escape');
    expect(below.onClose).toHaveBeenCalledTimes(1);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('closes on a press and release on the backdrop, not on a drag that ends there', async () => {
    const { show, onClose, host } = await page(twoFields);
    await show();
    const backdrop = host.querySelector<HTMLElement>('.backdrop')!;
    const title = host.querySelector<HTMLElement>('#title')!;
    const fire = (target: HTMLElement, type: string) => target.dispatchEvent(new MouseEvent(type, { bubbles: true }));

    // Selecting text in a field and letting go outside the card: the click lands on the backdrop.
    fire(title, 'pointerdown');
    fire(backdrop, 'click');
    expect(onClose).not.toHaveBeenCalled();

    fire(backdrop, 'pointerdown');
    fire(backdrop, 'click');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('DialogLayer that cannot be dismissed', () => {
  it('ignores Escape and a backdrop press', async () => {
    const onClose = vi.fn();
    const mounted = await mount(() =>
      h(DialogLayer, { dismissable: false, onClose }, () =>
        h('div', { class: 'lock' }, h(DialogPanel, null, () => h('div', { class: 'panel', tabindex: -1 }, [h(DialogHeading, null, () => h('h1', 'Locked')), h('input')]))),
      ),
    );
    cleanups.push(mounted.unmount);
    const lock = mounted.host.querySelector<HTMLElement>('.lock')!;

    press('Escape');
    lock.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    lock.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(onClose).not.toHaveBeenCalled();
    expect(mounted.host.querySelector('.panel')).not.toBeNull();
    // Nothing to choose from yet, so the panel itself holds focus - not a field or a key.
    expect(document.activeElement).toBe(mounted.host.querySelector('.panel'));
  });
});
