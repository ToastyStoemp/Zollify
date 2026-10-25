import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot } from '@zollify/sdk';

/** Videos a customer display plays between sales, kept on the device. */

const account: AccountSnapshot = {
  accountId: 'acct-display',
  accountName: 'Display Test',
  userId: 'u-1',
  email: 'owner@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'EUR' },
};

vi.mock('../session', () => ({
  getAccount: () => account,
  onAccountChange: () => () => {},
  authFetch: async () => ({}),
}));

const videos = await import('../core/display-videos');
const { deleteCoreDb } = await import('../core/db');

const file = (name: string, type = 'video/mp4', bytes = 1000): File => new File([new Uint8Array(bytes)], name, { type });

beforeEach(async () => {
  for (const v of await videos.listDisplayVideos()) await videos.removeDisplayVideo(v.id);
  await deleteCoreDb(account.accountId);
  await videos.loadDisplayVideoPrefs();
});

describe('display videos', () => {
  it('keeps the videos picked, in the order picked, and names anything that is not one', async () => {
    const result = await videos.addDisplayVideos([file('dragon.mp4'), file('notes.txt', 'text/plain'), file('fox.webm', 'video/webm', 2500)]);
    expect(result).toEqual({ added: 2, skipped: ['notes.txt'] });
    const list = await videos.listDisplayVideos();
    expect(list.map((v) => [v.name, v.type, v.size])).toEqual([
      ['dragon.mp4', 'video/mp4', 1000],
      ['fox.webm', 'video/webm', 2500],
    ]);
    // The list carries no file contents; the player asks for one at a time.
    expect(list[0]).not.toHaveProperty('blob');
    expect((await videos.displayVideoBlob(list[1]!.id))?.size).toBe(2500);
  });

  it('adds later videos at the end, and moves one up or down', async () => {
    await videos.addDisplayVideos([file('a.mp4'), file('b.mp4')]);
    await videos.addDisplayVideos([file('c.mp4')]);
    const [a, , c] = await videos.listDisplayVideos();
    await videos.moveDisplayVideo(c!.id, -1);
    expect((await videos.listDisplayVideos()).map((v) => v.name)).toEqual(['a.mp4', 'c.mp4', 'b.mp4']);
    // Already first: stays put.
    await videos.moveDisplayVideo(a!.id, -1);
    expect((await videos.listDisplayVideos()).map((v) => v.name)).toEqual(['a.mp4', 'c.mp4', 'b.mp4']);
  });

  it('forgets a removed video', async () => {
    await videos.addDisplayVideos([file('a.mp4'), file('b.mp4')]);
    const [a] = await videos.listDisplayVideos();
    await videos.removeDisplayVideo(a!.id);
    expect((await videos.listDisplayVideos()).map((v) => v.name)).toEqual(['b.mp4']);
    expect(await videos.displayVideoBlob(a!.id)).toBeNull();
  });

  it('plays them under the cart by default, and remembers this device’s choice', async () => {
    expect({ ...videos.displayVideoPrefs }).toEqual({ enabled: true, mode: 'overlay' });
    await videos.setDisplayVideoPrefs({ mode: 'swap', enabled: false });
    Object.assign(videos.displayVideoPrefs, { enabled: true, mode: 'overlay' });
    expect(await videos.loadDisplayVideoPrefs()).toEqual({ enabled: false, mode: 'swap' });
  });
});
