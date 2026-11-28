import { ref, type Ref } from 'vue';

const FALLBACK = 'Something went wrong.';

/** What to show a person for a caught value: its own message when it has one, else the fallback. */
export function errorText(err: unknown, fallback = FALLBACK): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

/**
 * How a run ended. `skipped` is a call that was ignored because an earlier
 * one was still running - not a failure, but not a success either, so a
 * caller that navigates on `ok` does it once.
 */
export type AsyncResult<T> =
  | { ok: true; value: T }
  | { ok: false; skipped: true }
  | { ok: false; skipped: false; error: unknown; message: string };

export interface AsyncActionOptions {
  /** Shown when the thrown value carries no message of its own. */
  fallback?: string;
  /** Called with every failure, e.g. to raise a toast or log it. */
  onError?: (message: string, err: unknown) => void;
}

export interface AsyncAction<A extends unknown[], T> {
  run: (...args: A) => Promise<AsyncResult<T>>;
  busy: Ref<boolean>;
  error: Ref<string | null>;
}

/**
 * One button press, one piece of work. `run` never rejects: it reports how
 * the work ended, so a caller cannot move on after a failure by accident.
 *
 * `busy` is set before the work starts, in the same tick as the tap, so a
 * double tap finds it set and is ignored - a `:disabled` binding alone only
 * takes effect at the next render, which is too late for the second tap.
 */
export function useAsyncAction<A extends unknown[], T>(
  work: (...args: A) => T | Promise<T>,
  options: AsyncActionOptions = {},
): AsyncAction<A, T> {
  const busy = ref(false);
  const error = ref<string | null>(null);

  async function run(...args: A): Promise<AsyncResult<T>> {
    if (busy.value) return { ok: false, skipped: true };
    busy.value = true;
    error.value = null;
    try {
      return { ok: true, value: await work(...args) };
    } catch (err) {
      const message = errorText(err, options.fallback);
      error.value = message;
      options.onError?.(message, err);
      return { ok: false, skipped: false, error: err, message };
    } finally {
      busy.value = false;
    }
  }

  return { run, busy, error };
}
