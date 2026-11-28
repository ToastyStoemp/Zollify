/**
 * Runs an async task at most once at a time. `busy` flips before the task's
 * first await, so a second tap that lands while the first is still checking
 * something (is the reader signed in?) is seen and dropped, instead of
 * starting the same thing twice.
 */
export interface SingleFlight {
  /** True from the moment a run starts until it settles. */
  readonly busy: boolean;
  /** Starts the task unless one is running. False when the call was dropped. */
  run(): boolean;
}

export function singleFlight(task: () => Promise<void>): SingleFlight {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    run(): boolean {
      if (busy) return false;
      busy = true;
      void task()
        .catch(() => undefined)
        .finally(() => (busy = false));
      return true;
    },
  };
}
