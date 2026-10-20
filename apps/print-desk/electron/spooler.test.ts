import { describe, expect, it } from 'vitest';
import { finishedOf, newJob, parseOutcome, parseSnapshot, progressOf, targetPrinter } from './spooler.js';

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

  it('counts copies done and left from pages printed', () => {
    const job = before.jobs[0]!;
    expect(progressOf('k', 10, job, before.printers[0])).toEqual({ key: 'k', copies: 10, printed: 8, left: 2, status: 'Printing · Low ink', done: false });
    expect(progressOf('k', 5, job, undefined)).toMatchObject({ printed: 5, left: 0 });
    expect(progressOf('k', 5, { ...job, status: '', pagesPrinted: 0 }, undefined)).toMatchObject({ printed: 0, status: 'Queued' });
  });
});

describe('parseOutcome', () => {
  // Windows' print log as the script lists it: job 14 printed 9 pages, job 13 was deleted, job 14 on another printer.
  const log = JSON.stringify([
    { id: 310, job: 13, printer: 'Canon PRO-1000 series', pages: 0 },
    { id: 307, job: 14, printer: 'Canon PRO-1000 series', pages: 9 },
    { id: 310, job: 14, printer: 'Canon PRO-1000 series', pages: 0 },
    { id: 307, job: 14, printer: 'Brother DCP-L2530DW', pages: 2 },
  ]);
  it('reads printed (with pages) over deleted, for that printer and job', () => {
    expect(parseOutcome(log, 'canon pro-1000 series', 14)).toEqual({ kind: 'printed', pages: 9 });
    expect(parseOutcome(log, 'Canon PRO-1000 series', 13)).toEqual({ kind: 'deleted' });
    expect(parseOutcome(log, 'Canon PRO-1000 series', 15)).toBeNull();
  });
  it('takes one event, or none, as PowerShell prints them', () => {
    expect(parseOutcome(JSON.stringify({ id: 307, job: 3, printer: 'P', pages: 2 }), 'P', 3)).toEqual({ kind: 'printed', pages: 2 });
    expect(parseOutcome('', 'P', 3)).toBeNull();
  });
});

describe('finishedOf', () => {
  it('counts what Windows logged as printed', () => {
    expect(finishedOf('k', 9, 7, { kind: 'printed', pages: 9 })).toEqual({ key: 'k', copies: 9, printed: 9, left: 0, status: 'Printed', done: true });
    expect(finishedOf('k', 3, 0, { kind: 'printed', pages: 5 }).printed).toBe(3);
  });
  it('counts only the copies sent before a cancel', () => {
    expect(finishedOf('k', 9, 4, { kind: 'deleted' })).toEqual({ key: 'k', copies: 9, printed: 4, left: 0, status: 'Cancelled after 4 of 9', done: true, cancelled: true });
  });
  it('takes all copies when Windows logged nothing', () => {
    expect(finishedOf('k', 9, 4, null)).toMatchObject({ printed: 9, done: true });
  });
});
