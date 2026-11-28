import { describe, expect, it, vi } from 'vitest';
import { errorText, useAsyncAction } from '../async-action';

/** A promise the test settles by hand, to hold an action mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('errorText', () => {
  it('uses the message an Error carries', () => {
    expect(errorText(new Error('Disk full'), 'Could not save.')).toBe('Disk full');
  });
  it('falls back for anything without a message', () => {
    expect(errorText(null, 'Could not save.')).toBe('Could not save.');
    expect(errorText(new Error(''), 'Could not save.')).toBe('Could not save.');
    expect(errorText({ code: 7 })).toBe('Something went wrong.');
  });
  it('passes a thrown string through', () => {
    expect(errorText('Offline')).toBe('Offline');
  });
});

describe('useAsyncAction', () => {
  it('ignores a second call while the first is running', async () => {
    const gate = deferred<string>();
    const work = vi.fn(() => gate.promise);
    const { run } = useAsyncAction(work);

    const first = run();
    const second = await run();
    gate.resolve('saved');

    expect(second).toEqual({ ok: false, skipped: true });
    expect(await first).toEqual({ ok: true, value: 'saved' });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('is busy from the call itself until the work settles', async () => {
    const gate = deferred<void>();
    const { run, busy } = useAsyncAction(() => gate.promise);

    expect(busy.value).toBe(false);
    const running = run();
    expect(busy.value).toBe(true);
    gate.resolve();
    await running;
    expect(busy.value).toBe(false);
  });

  it('runs again once the first call has finished', async () => {
    const work = vi.fn(async (n: number) => n * 2);
    const { run } = useAsyncAction(work);

    expect(await run(2)).toEqual({ ok: true, value: 4 });
    expect(await run(5)).toEqual({ ok: true, value: 10 });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('reports a failure instead of rejecting, and hands it to onError', async () => {
    const boom = new Error('Server said no');
    const onError = vi.fn();
    const { run, busy, error } = useAsyncAction(async () => Promise.reject(boom), { onError });

    const result = await run();

    expect(result).toEqual({ ok: false, skipped: false, error: boom, message: 'Server said no' });
    expect(error.value).toBe('Server said no');
    expect(onError).toHaveBeenCalledWith('Server said no', boom);
    expect(busy.value).toBe(false);
  });

  it('clears the last error when the next run starts', async () => {
    let fail = true;
    const { run, error } = useAsyncAction(async () => {
      if (fail) throw new Error('First try failed');
    });

    await run();
    expect(error.value).toBe('First try failed');
    fail = false;
    expect((await run()).ok).toBe(true);
    expect(error.value).toBeNull();
  });

  it('treats a function that throws before returning a promise the same way', async () => {
    const { run, busy, error } = useAsyncAction((): Promise<void> => {
      throw new TypeError('Not a number');
    });

    const result = await run();

    expect(result.ok).toBe(false);
    expect(error.value).toBe('Not a number');
    expect(busy.value).toBe(false);
  });

  it('uses the fallback when the thrown value says nothing', async () => {
    const { run, error } = useAsyncAction(async () => Promise.reject(undefined), { fallback: 'Could not save that product.' });
    await run();
    expect(error.value).toBe('Could not save that product.');
  });
});
