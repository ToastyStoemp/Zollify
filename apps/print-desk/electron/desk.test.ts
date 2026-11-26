import { describe, expect, it } from 'vitest';
import { sharedOf, statusReport, withShared } from './desk';
import { DEFAULTS } from './store';

const settings = { ...DEFAULTS, itemTargets: { acc: { 'k:a3': 4 }, other: { x: 1 } }, hidden: { other: ['y'] } };

describe('shared settings', () => {
  it('sends only the shared settings a change touches, this account’s part of the per-account ones', () => {
    expect(sharedOf({ target: 5, links: {}, theme: 'dark' }, 'acc')).toEqual({ target: 5 });
    expect(sharedOf({ itemTargets: settings.itemTargets, hidden: settings.hidden }, 'acc')).toEqual({ itemTargets: { 'k:a3': 4 }, hidden: [] });
  });
  it('takes the server’s settings for this account and leaves other accounts as they are', () => {
    const next = withShared(settings, 'acc', { target: 7, itemTargets: { 'k:a4': 2 }, order: ['k:a4'] });
    expect(next).toEqual({ target: 7, itemTargets: { acc: { 'k:a4': 2 }, other: { x: 1 } }, order: { acc: ['k:a4'] } });
  });
});

describe('status report', () => {
  it('drops counts of 0 and cuts long messages to what the server takes', () => {
    const r = statusReport({ counts: { a: 2, b: 0 }, run: [{ key: 'a', copies: 2, printed: 0, left: 2, status: 'x'.repeat(400), done: false }], paper: {}, error: 'e'.repeat(600) });
    expect(r.counts).toEqual({ a: 2 });
    expect(r.run[0]!.status).toHaveLength(300);
    expect(r.error).toHaveLength(500);
  });
});
