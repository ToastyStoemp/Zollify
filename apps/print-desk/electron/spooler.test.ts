import { describe, expect, it } from 'vitest';
import { newJob, parseSnapshot, progressOf, targetPrinter } from './spooler.js';

// Shaped like the real Win32 output on this machine: a printing job whose TotalPages is 0, queued ones with null status.
const before = parseSnapshot(
  JSON.stringify({
    jobs: [
      { name: 'Canon PRO-1000 series, 2', id: 2, document: 'Kyoto_A3.png', status: 'Printing', pages: 8 },
      { name: 'Canon PRO-1000 series, 3', id: 3, document: 'Sky_A3.png', status: null, pages: 0 },
    ],
    printers: [
      { name: 'Canon PRO-1000 series', default: false, error: 5, offline: false },
      { name: 'Canon G500 series', default: true, error: 0, offline: false },
    ],
  }),
);

describe('spooler', () => {
  it('splits the printer from the job name and maps printer problems', () => {
    expect(before.jobs[0]).toEqual({ printer: 'Canon PRO-1000 series', id: 2, document: 'Kyoto_A3.png', status: 'Printing', pagesPrinted: 8 });
    expect(before.printers.map((p) => p.issue)).toEqual(['Low ink', '']);
  });

  it('reads a lone job or printer that PowerShell did not wrap in an array', () => {
    const s = parseSnapshot('{"jobs":{"name":"P, 7","id":7,"document":"a.png","status":null,"pages":null},"printers":{"name":"P","default":true,"error":null,"offline":true}}');
    expect(s.jobs).toEqual([{ printer: 'P', id: 7, document: 'a.png', status: '', pagesPrinted: 0 }]);
    expect(s.printers).toEqual([{ name: 'P', default: true, issue: 'Offline' }]);
  });

  it('finds the job a print added, not an older one with the same document name', () => {
    const after = parseSnapshot(
      JSON.stringify({
        jobs: [
          { name: 'Canon PRO-1000 series, 3', id: 3, document: 'Sky_A3.png', pages: 0 },
          { name: 'Canon PRO-1000 series, 9', id: 9, document: 'sky_a3.png', pages: 0 },
        ],
        printers: [],
      }),
    );
    expect(newJob(before, after, 'canon pro-1000 series', 'Sky_A3.png')?.id).toBe(9);
    expect(newJob(before, before, 'Canon PRO-1000 series', 'Sky_A3.png')).toBeUndefined();
  });

  it('uses the default printer when the link names none', () => {
    expect(targetPrinter(before, undefined)).toBe('Canon G500 series');
    expect(targetPrinter(before, 'Canon PRO-1000 series')).toBe('Canon PRO-1000 series');
  });

  it('counts copies left from pages printed, and done once the job left the queue', () => {
    const job = before.jobs[0]!;
    expect(progressOf('k', 10, job, before.printers[0])).toEqual({ key: 'k', copies: 10, left: 2, status: 'Printing · Low ink', done: false });
    expect(progressOf('k', 5, job, undefined).left).toBe(0);
    expect(progressOf('k', 5, { ...job, status: '', pagesPrinted: 0 }, undefined).status).toBe('Queued');
    expect(progressOf('k', 5, undefined, undefined)).toEqual({ key: 'k', copies: 5, left: 0, status: 'Printed', done: true });
  });
});
