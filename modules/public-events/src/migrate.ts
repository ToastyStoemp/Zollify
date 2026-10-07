import { eventsToMigrateBooth, type EventOverlay, type SalesEvent } from '@zollify/shared';

/**
 * Moves the booth facts the Public events overlay used to hold (hall, booth
 * number, link, blurb) onto their events. Safe to run on every open: it only
 * fills empty event fields and writes nothing once everything is copied. The
 * overlay is left as it is so an older client keeps working.
 */
export interface BoothMigrationDeps {
  overlays(): Promise<Record<string, EventOverlay>>;
  events(): SalesEvent[];
  upsert(event: SalesEvent): Promise<void>;
}

/** Returns how many events were updated. Never throws: a failed run just retries next time. */
export async function migrateBoothToEvents(deps: BoothMigrationDeps): Promise<number> {
  try {
    const changed = eventsToMigrateBooth(deps.events(), await deps.overlays());
    for (const event of changed) await deps.upsert(event);
    return changed.length;
  } catch {
    return 0;
  }
}
