import { describe, expect, it } from 'vitest';
import { singleFlight } from '../lib/single-flight';

/**
 * Card on the till first asks the reader whether it is signed in. The pay
 * buttons stay live for that moment, so a second tap must not start a second
 * terminal run.
 */
describe('singleFlight', () => {
  it('drops a second start while the first is still running, and takes one again afterwards', async () => {
    let runs = 0;
    let finish = (): void => {};
    const start = singleFlight(async () => {
      runs++;
      await new Promise<void>((resolve) => (finish = resolve));
    });

    expect(start.run()).toBe(true);
    // Busy before the task's first await has resolved.
    expect(start.busy).toBe(true);
    expect(start.run()).toBe(false);
    expect(runs).toBe(1);

    finish();
    await new Promise((r) => setTimeout(r));
    expect(start.busy).toBe(false);
    expect(start.run()).toBe(true);
    expect(runs).toBe(2);
  });

  it('is free again after a run that threw', async () => {
    const start = singleFlight(async () => {
      throw new Error('reader check failed');
    });
    start.run();
    await new Promise((r) => setTimeout(r));
    expect(start.busy).toBe(false);
  });
});
