import { describe, expect, it } from 'vitest';
import { HostLibraryError } from '../engine/host-libs';

describe('HostLibraryError', () => {
  it('asks for an app update when the shell does not provide the library', () => {
    // What Chromium throws for a bare specifier the import map has no line for.
    const cause = new TypeError("Failed to resolve module specifier 'jspdf'");
    const err = new HostLibraryError('create PDFs', cause);
    expect(err.message).toBe('This version of the app cannot create PDFs - update the app, then try again.');
    expect(err.cause).toBe(cause);
  });

  it('asks to retry when the file did not arrive', () => {
    const err = new HostLibraryError('read spreadsheets', new TypeError('Failed to fetch dynamically imported module: /host/xlsx.js'));
    expect(err.message).toBe('Could not load what is needed to read spreadsheets - check the connection and try again.');
  });
});
