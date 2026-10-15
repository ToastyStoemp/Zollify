import { z } from 'zod';

/** Limits for files attached to an event, shared so the app and the server refuse the same things. */
export const EVENT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const EVENT_FILES_MAX_PER_EVENT = 20;
/** Notes are plain text; this is generous for a schedule and still bounded. */
export const EVENT_NOTES_MAX_CHARS = 20_000;

/** What can be attached: documents and pictures a phone can open. Never anything a browser would run. */
const MIME_OK = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'text/plain',
  'text/csv',
  'application/vnd.apple.pkpass',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const isEventFileMime = (mime: string): boolean => MIME_OK.has(mime.toLowerCase());

/** Mime of a picked file; some browsers leave it empty for .pkpass and the like. */
export function eventFileMime(name: string, reported: string): string {
  if (reported) return reported.toLowerCase();
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'pkpass' ? 'application/vnd.apple.pkpass' : ext === 'pdf' ? 'application/pdf' : '';
}

export const EventFileUploadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mime: z.string().max(100).refine(isEventFileMime, 'That kind of file cannot be attached.'),
  /** base64 of the file's bytes. */
  data: z.string().min(1),
});
export type EventFileUpload = z.infer<typeof EventFileUploadSchema>;

export interface EventFileDownload {
  name: string;
  mime: string;
  data: string;
}

export const formatFileSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
