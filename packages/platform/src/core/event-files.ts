import {
  EVENT_FILES_MAX_PER_EVENT,
  EVENT_NOTES_MAX_CHARS,
  checkPickedFile,
  eventFileMime,
  isEventFileMime,
  type EventAttachment,
  type EventFileDownload,
  type SalesEvent,
} from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount, authFetch } from '../session';
import { base64ToBlob, blobToBase64 } from './images';
import { getSalesEvent, upsertSalesEvent } from './sales-events';

/**
 * Notes and attached files on an event - setup times, the stand number,
 * tickets, the floor plan.
 *
 * The notes and the list of attachments are part of the event, so they sync
 * like any other change to it. The bytes do not: they go to the server's file
 * store on their own and every device keeps a copy once it has opened one, so
 * a ticket opened once at home still opens at a venue with no signal.
 */

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Event files were used while signed out.');
  return account.accountId;
}
const db = () => openCoreDb(requireAccountId());
const fileUrl = (eventId: string, id: string): string => `/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(id)}`;

function requireEvent(eventId: string): SalesEvent {
  const event = getSalesEvent(eventId);
  if (!event) throw new Error('That event no longer exists.');
  return event;
}

export async function setEventNotes(eventId: string, notes: string): Promise<void> {
  if (notes.length > EVENT_NOTES_MAX_CHARS) throw new Error(`Notes can be ${EVENT_NOTES_MAX_CHARS.toLocaleString('en')} characters at most.`);
  const event = requireEvent(eventId);
  const next = notes.trim() ? notes : undefined;
  if ((event.notes ?? undefined) === next) return;
  await upsertSalesEvent({ ...event, notes: next });
}

async function upload(eventId: string, att: Pick<EventAttachment, 'id' | 'name' | 'mime'>, blob: Blob): Promise<void> {
  await authFetch(fileUrl(eventId, att.id), {
    method: 'PUT',
    body: JSON.stringify({ name: att.name, mime: att.mime, data: await blobToBase64(blob) }),
  });
  await db().eventFiles.update(att.id, { uploaded: 1 });
}

/**
 * Attaches a picked file. It is kept here first and sent to the server right
 * away; offline, it stays marked as waiting and goes up on the next
 * retryEventFileUploads(), while the event already lists it.
 */
export async function addEventFile(eventId: string, file: File): Promise<EventAttachment> {
  const event = requireEvent(eventId);
  const mime = eventFileMime(file.name, file.type);
  if (!isEventFileMime(mime)) throw new Error('Attach a PDF, a picture, a Wallet pass or a plain document.');
  // The same check the server makes: size and real type, before anything is read or sent.
  const problem = await checkPickedFile('eventFile', file);
  if (problem) throw new Error(problem);
  if ((event.attachments?.length ?? 0) >= EVENT_FILES_MAX_PER_EVENT) throw new Error(`An event can hold ${EVENT_FILES_MAX_PER_EVENT} files.`);

  const att: EventAttachment = { id: crypto.randomUUID(), name: file.name.slice(0, 200), mime, size: file.size, addedAt: Date.now() };
  const blob = file.slice(0, file.size, mime);
  await db().eventFiles.put({ id: att.id, eventId, blob, uploaded: 0 });
  try {
    await upload(eventId, att, blob);
  } catch (err) {
    // A refusal (too big for the account, not allowed) is final - don't list a file nobody can ever get.
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) {
      await db().eventFiles.delete(att.id);
      throw err;
    }
  }
  // Re-read: the upload took a while and the event may have changed under it.
  const fresh = requireEvent(eventId);
  await upsertSalesEvent({ ...fresh, attachments: [...(fresh.attachments ?? []), att] });
  return att;
}

export async function removeEventFile(eventId: string, attachmentId: string): Promise<void> {
  const event = requireEvent(eventId);
  await upsertSalesEvent({ ...event, attachments: (event.attachments ?? []).filter((a) => a.id !== attachmentId) });
  await db().eventFiles.delete(attachmentId);
  // Best effort: if this fails the file is only orphaned on the server, never shown again.
  await authFetch(fileUrl(eventId, attachmentId), { method: 'DELETE' }).catch(() => undefined);
}

/** Drops every file of an event that is being deleted. */
export async function removeAllEventFiles(event: SalesEvent): Promise<void> {
  for (const att of event.attachments ?? []) {
    await db().eventFiles.delete(att.id);
    await authFetch(fileUrl(event.id, att.id), { method: 'DELETE' }).catch(() => undefined);
  }
}

/** The file's bytes: from this device if it has them, otherwise fetched once and kept. */
export async function eventFileBlob(eventId: string, att: EventAttachment): Promise<Blob> {
  const local = await db().eventFiles.get(att.id);
  if (local) return local.blob;
  const got = (await authFetch(fileUrl(eventId, att.id))) as EventFileDownload;
  const blob = base64ToBlob(got.data, att.mime);
  await db().eventFiles.put({ id: att.id, eventId, blob, uploaded: 1 });
  return blob;
}

/** Whether this device already has the file, so the UI can say what works offline. */
export async function eventFileCached(attachmentId: string): Promise<boolean> {
  return Boolean(await db().eventFiles.get(attachmentId));
}

/** Sends files that were attached while offline. Safe to call any time; returns how many are still waiting. */
export async function retryEventFileUploads(): Promise<number> {
  const waiting = (await db().eventFiles.toArray()).filter((r) => r.uploaded === 0);
  let left = 0;
  for (const rec of waiting) {
    const att = getSalesEvent(rec.eventId)?.attachments?.find((a) => a.id === rec.id);
    if (!att) {
      // Removed or never listed: nothing refers to it any more.
      await db().eventFiles.delete(rec.id);
      continue;
    }
    try {
      await upload(rec.eventId, att, rec.blob);
    } catch {
      left++;
    }
  }
  return left;
}
