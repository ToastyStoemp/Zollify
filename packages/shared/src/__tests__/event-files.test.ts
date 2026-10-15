import { describe, expect, it } from 'vitest';
import { eventFileMime, formatFileSize, isEventFileMime } from '../event-files';

describe('event files', () => {
  it('accepts tickets and pictures, never anything a browser would run', () => {
    for (const ok of ['application/pdf', 'image/png', 'IMAGE/JPEG', 'application/vnd.apple.pkpass']) expect(isEventFileMime(ok)).toBe(true);
    for (const bad of ['text/html', 'image/svg+xml', 'application/javascript', 'application/x-msdownload', '']) expect(isEventFileMime(bad)).toBe(false);
  });

  it('fills in a type the browser left empty for the files people attach most', () => {
    expect(eventFileMime('ticket.PKPASS', '')).toBe('application/vnd.apple.pkpass');
    expect(eventFileMime('Ticket.pdf', '')).toBe('application/pdf');
    expect(eventFileMime('mystery.bin', '')).toBe('');
    expect(eventFileMime('a.png', 'Image/PNG')).toBe('image/png');
  });

  it('writes sizes people can read', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
