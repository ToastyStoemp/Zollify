import { normalizeConfiguratorUrl, parseBoothLayout, sanitizeBoothLayout, type BoothLayout } from '@zollify/shared';
import { getSalesEvent, upsertSalesEvent } from './sales-events';
import { getSyncedSetting, setSyncedSetting } from './synced-settings';

/**
 * An event's booth layout, exported from the Cube Studio configurator. It is a
 * field on the event, so it syncs like any other change to it; the stored form
 * is slim (no artwork or stand meshes - see parseBoothLayout), which keeps the
 * event record small enough to ride the op log.
 */

const CONFIGURATOR_KEY = 'core.cubeConfiguratorUrl';

function requireEvent(eventId: string) {
  const event = getSalesEvent(eventId);
  if (!event) throw new Error('That event no longer exists.');
  return event;
}

/** Sets or (with undefined) removes the layout. */
export async function setEventBoothLayout(eventId: string, layout: BoothLayout | undefined): Promise<void> {
  const { boothLayout: _old, ...rest } = requireEvent(eventId);
  await upsertSalesEvent(layout ? { ...rest, boothLayout: layout } : rest);
}

/** Validates the text of an exported design file and stores it on the event, replacing any earlier one. */
export async function importEventBoothLayout(eventId: string, text: string, fileName?: string): Promise<BoothLayout> {
  const parsed = parseBoothLayout(text, { fileName });
  if (!parsed.ok) throw new Error(parsed.error);
  await setEventBoothLayout(eventId, parsed.layout);
  return parsed.layout;
}

/** Gives `targetId` the layout of `sourceId`, e.g. last year's edition. */
export async function copyEventBoothLayout(sourceId: string, targetId: string): Promise<void> {
  const layout = sanitizeBoothLayout(requireEvent(sourceId).boothLayout);
  if (!layout) throw new Error('That event has no layout to copy.');
  await setEventBoothLayout(targetId, { ...layout, importedAt: Date.now() });
}

/** The hosted configurator's address; empty when none is set. */
export async function getConfiguratorUrl(): Promise<string> {
  return normalizeConfiguratorUrl((await getSyncedSetting<string>(CONFIGURATOR_KEY)) ?? '');
}

export async function setConfiguratorUrl(url: string): Promise<string> {
  const clean = normalizeConfiguratorUrl(url);
  if (url.trim() && !clean) throw new Error('Enter a web address starting with https://');
  await setSyncedSetting(CONFIGURATOR_KEY, clean);
  return clean;
}
