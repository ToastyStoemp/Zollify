// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import ZButton from '../ZButton.vue';
import { mount, settle } from './mount';

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.restoreAllMocks();
});

async function button(props: Record<string, unknown> = {}): Promise<HTMLButtonElement> {
  const mounted = await mount(() => h(ZButton, props, () => 'Save'));
  unmount = mounted.unmount;
  return mounted.host.querySelector('button')!;
}

describe('ZButton', () => {
  it('is a plain button wearing the shell classes', async () => {
    const el = await button({ variant: 'primary' });
    expect(el.type).toBe('button');
    expect(el.classList.contains('primary')).toBe(true);
    expect(el.textContent).toBe('Save');
    expect(el.disabled).toBe(false);
    expect(el.hasAttribute('aria-busy')).toBe(false);
  });

  it('adds no variant class by default, and passes type through', async () => {
    const el = await button({ type: 'submit' });
    expect(el.type).toBe('submit');
    expect(el.className).toBe('zfy-button');
  });

  it('shows busy: disabled, aria-busy, and the indicator', async () => {
    const el = await button({ busy: true });
    expect(el.disabled).toBe(true);
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.querySelector('.progress')).not.toBeNull();
  });

  it('runs its action once for a double tap, busy while it runs', async () => {
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const el = await button({ action });

    // Two clicks in the same tick: the second arrives before any re-render.
    el.click();
    el.click();
    await settle();

    expect(action).toHaveBeenCalledTimes(1);
    expect(el.disabled).toBe(true);
    expect(el.getAttribute('aria-busy')).toBe('true');

    finish();
    await settle();
    expect(el.disabled).toBe(false);
    expect(el.querySelector('.progress')).toBeNull();
  });

  it('reports a failed action and can be pressed again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onError = vi.fn();
    const action = vi.fn(async () => Promise.reject(new Error('Could not save')));
    const el = await button({ action, onError });

    el.click();
    await settle();

    expect(onError).toHaveBeenCalledWith('Could not save', expect.any(Error));
    expect(el.disabled).toBe(false);
    el.click();
    await settle();
    expect(action).toHaveBeenCalledTimes(2);
  });
});
