/**
 * Phomemo M110 Bluetooth LE driver.
 *
 * Built on @capacitor-community/bluetooth-le rather than raw Web Bluetooth:
 * that plugin provides ONE API that works both as a real Capacitor native
 * plugin (the Android app - navigator.bluetooth does not exist inside its
 * WebView) and, when there is no native platform, falls back to Web
 * Bluetooth itself (desktop Chrome/Edge, Chrome-for-Android as an ordinary
 * site). This file no longer needs to know which one it's talking to.
 *
 * The M110 has no public protocol spec - everything below is reverse-engineered
 * community knowledge (sniffed from the vendor Android app), cross-checked
 * across two independent projects:
 *   - https://github.com/mkuhlmann/pyphomemo (GATT service/characteristics)
 *   - https://github.com/vivier/phomemo-tools (M110/M120/M220-specific command
 *     bytes and raster width, as distinct from the older M02)
 * Mostly not verified against a real M110 by this codebase - the printer
 * manual documents none of this. If a command below turns out wrong, trust a
 * fresh packet capture over this file. One thing IS confirmed live: the
 * device does not advertise a "Phomemo"/"M110" name over BLE - it showed up
 * in the picker as something like "Q199…" (a generic module name, not the
 * marketed model). Device discovery below deliberately doesn't filter by
 * name for that reason - see connect().
 *
 * Confirmed fixed:
 *   - Service 0xff00, write characteristic 0xff02, notify 0xff03.
 *   - Print head is 344 dots (43 bytes) wide on M110/M120/M220 - not the same
 *     as the older M02's 384 dots. This is the one thing an incorrect value
 *     for would produce - garbled/offset prints - so it is not a knob here.
 *   - Media type 0x1f 0x11 0x0a selects gap-sensing (die-cut) labels, which
 *     is what a 40x30mm roll is.
 *   - Image data is the standard ESC/POS "GS v 0" raster command
 *     (0x1d 0x76 0x30), followed by bytes-per-line and line-count as
 *     little-endian 16-bit values, then the raw 1-bit raster bytes.
 *   - Writes are chunked to 128 bytes - BLE GATT payload size the vendor app
 *     itself stays under.
 *
 * Confirmed against a live device (Q199G2CK0820239) plus a second, known-
 * working browser implementation of this same protocol
 * (https://github.com/ToastyStoemp/pippo-label-studio):
 *   - Speed/density byte shape, raster header/footer bytes and ordering all
 *     match pippo-label-studio's `m110.js` exactly.
 *   - This unit's ff02 characteristic reports writeWithoutResponse=false -
 *     writes must use writeValueWithResponse (see connect()/write() below).
 *     Calling writeValueWithoutResponse on it throws NotSupportedError,
 *     which without this fix reads as "connects but nothing prints".
 *   - Timing matters: pippo-label-studio inserts 30ms after speed/density
 *     (before the raster header), 300ms after the last raster chunk, and
 *     500ms after the footer, on top of the 20ms inter-chunk delay already
 *     used here - added below to match, since skipping them is a plausible
 *     second reason for a connected-but-silent printer.
 *
 * Genuinely untested: the Android-native path through bluetooth-le (the web
 * path above was verified live; switching the write/notify plumbing to this
 * plugin for Android has not been tried against a real device yet).
 */
import { BleClient, numberToUUID, type BleDevice } from '@capacitor-community/bluetooth-le';

const SERVICE_UUID = numberToUUID(0xff00);
const WRITE_CHARACTERISTIC_UUID = numberToUUID(0xff02);
const NOTIFY_CHARACTERISTIC_UUID = numberToUUID(0xff03);

/** Print head width - fixed by the hardware, not a label setting. */
export const PRINTER_DOTS_WIDE = 344;
export const PRINTER_BYTES_WIDE = PRINTER_DOTS_WIDE / 8;

/** Raster blocks are kept to this many lines - the one real capture seen used exactly this for a 30mm-tall label. */
const MAX_LINES_PER_BLOCK = 240;

/** Delay between GATT writes - the M110's BLE stack is slow; back-to-back writes without this drop bytes in practice on similar community drivers. Tune down if reliable. */
const WRITE_DELAY_MS = 20;
const CHUNK_SIZE = 128;
/** 'safe' mode's cushion on top of the same fixed wait 'continuous' uses - see printRaster. */
const SAFE_EXTRA_MS = 300;

/**
 * 'continuous' (default): paces jobs with the fixed, height-scaled delay
 * only - fast, but that delay is a guess (see printRaster).
 * 'safe': waits that same fixed delay first, THEN an extra cushion on top -
 * shortened if a fresh ff03 notification arrives during the cushion, but
 * never shorter than 'continuous' outright. (An earlier version raced the
 * notification against the fixed delay instead of adding to it, so it could
 * finish at or before 'continuous' - strictly no safer, and worse if this
 * printer's ff03 fires on something other than "done printing", which is
 * unconfirmed; nothing here decodes what it actually sends.) If ff03 never
 * notifies (unsupported firmware), the cushion just runs its full length.
 */
export type PrintMode = 'continuous' | 'safe';

export interface PhomemoOptions {
  /** 1-5. Default is 4 - not verified against real hardware, adjust if labels feed unevenly. */
  speed?: number;
  /** 1-15. Default is a middle value - not verified against real hardware. */
  density?: number;
  mode?: PrintMode;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PhomemoPrinter {
  private device: BleDevice | null = null;
  private isConnected = false;
  private initialized = false;
  /**
   * Confirmed live: this device's ff02 characteristic reports
   * writeWithoutResponse=false (Windows WebBluetooth), unlike most
   * printers this protocol was reverse-engineered from. Writing with
   * the wrong method throws, silently, if the call site doesn't surface
   * it - which reads as "connects but prints nothing". Picked once at
   * connect() time from the real properties.
   */
  private useWriteWithResponse = false;
  private hasNotify = false;
  private lastNotifyAt = 0;
  /** Reset on every connect() - see printRaster's own use of this. */
  private printedSinceConnect = false;

  get connected(): boolean {
    return this.isConnected;
  }

  get name(): string | undefined {
    return this.device?.name;
  }

  /** Must be called from a user gesture (a click handler) - Web Bluetooth requirement; bluetooth-le carries this through on the web fallback. */
  async connect(): Promise<void> {
    if (!this.initialized) {
      // androidNeverForLocation matches this app's manifest declaration
      // (BLUETOOTH_SCAN usesPermissionFlags="neverForLocation") - scanning
      // here genuinely never derives location, so the stricter permission
      // set applies instead of also requiring ACCESS_FINE_LOCATION on API 31+.
      await BleClient.initialize({ androidNeverForLocation: true });
      this.initialized = true;
    }
    // Not filtered by service: bluetooth-le only passes a `services` filter
    // through to Web Bluetooth's own device-advertisement filter, which these
    // printers fail (they only expose 0xff00 in their GATT table once
    // connected, not in the raw advertisement packet) - confirmed live, see
    // the file header. Omitting it shows every nearby device instead and
    // lets the user pick the printer by name; `optionalServices` is still
    // required for the 0xff00 lookup below to be allowed once connected.
    this.device = await BleClient.requestDevice({
      optionalServices: [SERVICE_UUID, numberToUUID(0x1800), numberToUUID(0x180a), numberToUUID(0x180f)],
    });
    await BleClient.connect(this.device.deviceId, () => {
      this.isConnected = false;
    });
    this.isConnected = true;
    this.printedSinceConnect = false;

    const services = await BleClient.getServices(this.device.deviceId);
    const service = services.find((s) => s.uuid.toLowerCase() === SERVICE_UUID.toLowerCase());
    const writeChar = service?.characteristics.find((c) => c.uuid.toLowerCase() === WRITE_CHARACTERISTIC_UUID.toLowerCase());
    this.useWriteWithResponse = !writeChar?.properties.writeWithoutResponse;

    // Best-effort: 'safe' mode uses this if it shows up, but nothing here
    // depends on it existing or on decoding what it sends.
    try {
      await BleClient.startNotifications(this.device.deviceId, SERVICE_UUID, NOTIFY_CHARACTERISTIC_UUID, () => {
        this.lastNotifyAt = Date.now();
      });
      this.hasNotify = true;
    } catch {
      this.hasNotify = false;
    }
  }

  disconnect(): void {
    if (this.device) void BleClient.disconnect(this.device.deviceId).catch(() => undefined);
    this.device = null;
    this.isConnected = false;
    this.hasNotify = false;
  }

  /**
   * Debug aid for "the printer connected but nothing prints": lists every
   * GATT service and characteristic actually on the connected device. Only
   * shows services declared in `optionalServices` above - if 0xff00 doesn't
   * show up here even though the device is connected, this printer's
   * firmware uses a different service UUID than the one this driver assumes,
   * and that's the real thing to chase next (not the write logic).
   */
  async listServices(): Promise<string> {
    if (!this.device || !this.isConnected) throw new Error('Not connected to a printer.');
    const services = await BleClient.getServices(this.device.deviceId);
    const lines: string[] = [`Device: ${this.device.name ?? '(unnamed)'}`];
    for (const service of services) {
      lines.push(`Service ${service.uuid}`);
      for (const c of service.characteristics) {
        const props = Object.entries(c.properties)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', ');
        lines.push(`  Characteristic ${c.uuid} (${props})`);
      }
    }
    return lines.join('\n');
  }

  /** Resolves once a notification has arrived after this call, or after `timeoutMs` - whichever is first. */
  private waitForNotifyOrTimeout(timeoutMs: number): Promise<void> {
    if (!this.hasNotify) return sleep(timeoutMs);
    const armedAt = Date.now();
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (this.lastNotifyAt >= armedAt) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
      setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, timeoutMs);
    });
  }

  private async write(bytes: number[]): Promise<void> {
    if (!this.device || !this.isConnected) throw new Error('Not connected to a printer.');
    const deviceId = this.device.deviceId;
    const data = new Uint8Array(bytes);
    for (let i = 0; i < data.length; i += CHUNK_SIZE) {
      const chunk = data.slice(i, i + CHUNK_SIZE);
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (this.useWriteWithResponse) await BleClient.write(deviceId, SERVICE_UUID, WRITE_CHARACTERISTIC_UUID, view);
      else await BleClient.writeWithoutResponse(deviceId, SERVICE_UUID, WRITE_CHARACTERISTIC_UUID, view);
      await sleep(WRITE_DELAY_MS);
    }
  }

  /** Sends `rows` as one or more GS-v-0 raster blocks (see printRaster's own docs for the header shape). */
  private async writeRasterRows(rows: Uint8Array[], bytesPerLine: number): Promise<void> {
    for (let start = 0; start < rows.length; start += MAX_LINES_PER_BLOCK) {
      const block = rows.slice(start, start + MAX_LINES_PER_BLOCK);
      const lineCount = block.length;
      const header = [
        0x1d, 0x76, 0x30, 0x00,
        bytesPerLine & 0xff, (bytesPerLine >> 8) & 0xff,
        lineCount & 0xff, (lineCount >> 8) & 0xff,
      ];
      const body: number[] = [];
      for (const row of block) body.push(...row);
      await this.write([...header, ...body]);
    }
  }

  /**
   * Prints one label from pre-rasterized rows (see raster.ts): one
   * `Uint8Array` per print line, MSB-first, 1 = ink. Row width can be
   * narrower than the head (labelDots() shrinks it for labels under
   * PRINTER_DOTS_WIDE) - the header must declare the row's real byte
   * width, not the head's, or every line reads shifted by the
   * difference (confirmed live: this is what produced a diagonally
   * garbled print). Split into blocks of `MAX_LINES_PER_BLOCK` automatically.
   */
  async printRaster(rows: Uint8Array[], options: PhomemoOptions = {}): Promise<void> {
    const speed = Math.min(5, Math.max(1, options.speed ?? 4));
    const density = Math.min(15, Math.max(1, options.density ?? 8));
    const bytesPerLine = rows[0]?.length ?? PRINTER_BYTES_WIDE;

    await this.write([0x1b, 0x4e, 0x0d, speed]);
    await sleep(30);
    await this.write([0x1b, 0x4e, 0x04, density]);
    await sleep(30);
    await this.write([0x1f, 0x11, 0x0a]);
    // Gap-sensing feed is a physical motor move, not instant - starting raster
    // data before it completes chops the top rows off the label (confirmed
    // live: this produced a print missing its first title line, with the
    // same amount of blank stock left over at the bottom).
    //
    // 30ms was only ever enough for a label printed after the mechanism was
    // already warmed up by a prior job - confirmed live, the very FIRST
    // label after connecting still glitched at 30ms (and even at a flat
    // 120ms bump) while every later label in the same session printed
    // clean. So this waits properly only on that first print: race a
    // notification against a generous timeout, the same infra 'safe' mode
    // uses, regardless of which pacing mode is selected - a slow first label
    // is a fair trade for it not being garbled. Every later print in the
    // session uses the fast fixed delay unconditionally.
    if (!this.printedSinceConnect) await this.waitForNotifyOrTimeout(400);
    else await sleep(120);

    await this.writeRasterRows(rows, bytesPerLine);
    this.printedSinceConnect = true;

    await sleep(300);
    await this.write([0x1f, 0xf0, 0x05, 0x00, 0x1f, 0xf0, 0x03, 0x00]);
    // Fixed 500ms here (matching the one reference source found) was only
    // ever validated at one label height (30mm / 240 lines). The footer
    // triggers a real mechanical feed-and-cut - the BLE write ack (even
    // write-with-response) confirms the bytes reached the printer's radio,
    // not that the motor finished moving - and that takes longer for a
    // taller label. Sending the next job's setup commands before it
    // finishes overlaps the next print onto the tail of this one, which is
    // the doubled/ghosted text and stray blank labels seen printing a mixed
    // batch. Scaled from that one known-good data point (240 lines -> 500ms
    // was enough) with headroom; not verified against real hardware at
    // other heights - tighten only with a batch print that stays clean.
    const settleMs = Math.max(500, Math.round(rows.length * 3));
    // Always the same base wait as 'continuous' first - 'safe' is meant to
    // be the MORE cautious option, but racing notify-vs-settleMs (as this
    // used to) can only ever finish at or before settleMs, never after.
    // Confirmed live: switching to 'safe' did not fix batches still coming
    // out corrupted at the boundary between different labels, consistent
    // with ff03 notifying on something other than "motor fully done" and
    // that race cutting the wait short. Notify can now only ADD wait time
    // on top of the same guess 'continuous' uses, never remove it.
    await sleep(settleMs);
    if ((options.mode ?? 'continuous') === 'safe') await this.waitForNotifyOrTimeout(SAFE_EXTRA_MS);
  }
}
