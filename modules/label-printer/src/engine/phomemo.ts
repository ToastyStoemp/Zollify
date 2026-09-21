/**
 * Phomemo M110 Bluetooth LE driver.
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
 */

const SERVICE_UUID = 0xff00;
const WRITE_CHARACTERISTIC_UUID = 0xff02;

/** Print head width - fixed by the hardware, not a label setting. */
export const PRINTER_DOTS_WIDE = 344;
export const PRINTER_BYTES_WIDE = PRINTER_DOTS_WIDE / 8;

/** Raster blocks are kept to this many lines - the one real capture seen used exactly this for a 30mm-tall label. */
const MAX_LINES_PER_BLOCK = 240;

/** Delay between GATT writes - the M110's BLE stack is slow; back-to-back writes without this drop bytes in practice on similar community drivers. Tune down if reliable. */
const WRITE_DELAY_MS = 20;
const CHUNK_SIZE = 128;

export interface PhomemoOptions {
  /** 1-5. Default is 4 - not verified against real hardware, adjust if labels feed unevenly. */
  speed?: number;
  /** 1-15. Default is a middle value - not verified against real hardware. */
  density?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PhomemoPrinter {
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  /**
   * Confirmed live: this device's ff02 characteristic reports
   * writeWithoutResponse=false (Windows WebBluetooth), unlike most
   * printers this protocol was reverse-engineered from. Writing with
   * the wrong method throws NotSupportedError - silently, if the call
   * site doesn't surface it - which reads as "connects but prints
   * nothing". Picked once at connect() time from the real properties.
   */
  private useWriteWithResponse = false;

  get connected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  get name(): string | undefined {
    return this.device?.name;
  }

  /** Must be called from a user gesture (a click handler) - Web Bluetooth requirement. */
  async connect(): Promise<void> {
    if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth support (Chrome/Edge on desktop or Android only - not Safari or iOS).');
    // Not filtered by service UUID: `filters: [{ services: [...] }]` only
    // matches a device that advertises that UUID in its raw BLE advertisement
    // packet, before any connection - these printers only expose 0xff00 in
    // their GATT table once connected, so a services filter hides them from
    // the picker entirely (confirmed against pyphomemo, which discovers the
    // M110 by device name, not by an advertised service). `acceptAllDevices`
    // shows every nearby BLE device instead and lets the user pick the
    // printer by name; `optionalServices` is still required for the 0xff00
    // lookup below to be allowed once connected.
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      // Web Bluetooth only allows GATT access to services listed here (or in
      // `filters`) at request time - an unlisted service is invisible even
      // to `getPrimaryServices()` after connecting. The standard ones below
      // cost nothing to declare and let `listServices()` show real
      // manufacturer/device info if the printer happens to expose it, which
      // is useful for confirming it's actually the right device.
      optionalServices: [SERVICE_UUID, 'generic_access', 'device_information', 'battery_service'],
    });
    const server = await this.device.gatt?.connect();
    if (!server) throw new Error('Could not open a GATT connection to the printer.');
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(WRITE_CHARACTERISTIC_UUID);
    this.useWriteWithResponse = !this.characteristic.properties.writeWithoutResponse;
  }

  disconnect(): void {
    this.device?.gatt?.disconnect();
    this.characteristic = null;
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
    const server = this.device?.gatt;
    if (!server?.connected) throw new Error('Not connected to a printer.');
    const services = await server.getPrimaryServices();
    const lines: string[] = [`Device: ${this.device?.name ?? '(unnamed)'}`];
    for (const service of services) {
      lines.push(`Service ${service.uuid}`);
      const chars = await service.getCharacteristics();
      for (const c of chars) {
        const props = Object.entries(c.properties)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', ');
        lines.push(`  Characteristic ${c.uuid} (${props})`);
      }
    }
    return lines.join('\n');
  }

  private async write(bytes: number[]): Promise<void> {
    if (!this.characteristic) throw new Error('Not connected to a printer.');
    const data = new Uint8Array(bytes);
    for (let i = 0; i < data.length; i += CHUNK_SIZE) {
      const chunk = data.slice(i, i + CHUNK_SIZE);
      if (this.useWriteWithResponse) await this.characteristic.writeValueWithResponse(chunk);
      else await this.characteristic.writeValueWithoutResponse(chunk);
      await sleep(WRITE_DELAY_MS);
    }
  }

  /**
   * Prints one label from pre-rasterized rows (see raster.ts): one
   * `Uint8Array` per print line, each `PRINTER_BYTES_WIDE` bytes, MSB-first,
   * 1 = ink. Split into blocks of `MAX_LINES_PER_BLOCK` automatically.
   */
  async printRaster(rows: Uint8Array[], options: PhomemoOptions = {}): Promise<void> {
    const speed = Math.min(5, Math.max(1, options.speed ?? 4));
    const density = Math.min(15, Math.max(1, options.density ?? 8));

    await this.write([0x1b, 0x4e, 0x0d, speed]);
    await this.write([0x1b, 0x4e, 0x04, density]);
    await sleep(30);
    await this.write([0x1f, 0x11, 0x0a]);

    for (let start = 0; start < rows.length; start += MAX_LINES_PER_BLOCK) {
      const block = rows.slice(start, start + MAX_LINES_PER_BLOCK);
      const lineCount = block.length;
      const header = [
        0x1d, 0x76, 0x30, 0x00,
        PRINTER_BYTES_WIDE & 0xff, (PRINTER_BYTES_WIDE >> 8) & 0xff,
        lineCount & 0xff, (lineCount >> 8) & 0xff,
      ];
      const body: number[] = [];
      for (const row of block) body.push(...row);
      await this.write([...header, ...body]);
    }

    await sleep(300);
    await this.write([0x1f, 0xf0, 0x05, 0x00, 0x1f, 0xf0, 0x03, 0x00]);
    await sleep(500);
  }
}
