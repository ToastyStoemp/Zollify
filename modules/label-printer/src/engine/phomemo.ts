/**
 * Phomemo M110 Bluetooth LE driver.
 *
 * The M110 has no public protocol spec - everything below is reverse-engineered
 * community knowledge (sniffed from the vendor Android app), cross-checked
 * across two independent projects:
 *   - https://github.com/mkuhlmann/pyphomemo (GATT service/characteristics)
 *   - https://github.com/vivier/phomemo-tools (M110/M120/M220-specific command
 *     bytes and raster width, as distinct from the older M02)
 * NOT verified against a real M110 by this codebase - the printer manual
 * documents none of this. If a command below turns out wrong, trust a fresh
 * packet capture over this file.
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
 * Genuinely uncertain (exposed as adjustable settings rather than baked in):
 *   - Speed/density: documented as "0x1b 0x4e 0x0d" / "0x1b 0x4e 0x04" with a
 *     noted value range (1-5, 1-15) but the capture that revealed this didn't
 *     show whether that's a fixed 3rd byte or a 4th parameter byte. Modelled
 *     here as opcode + one parameter byte (the common ESC/POS shape); if
 *     printing failed outright this would be the first thing to try dropping.
 *   - Footer order (two 0x1f 0xf0 commands) - sent in the order the source
 *     listed them; unconfirmed against real hardware.
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

  get connected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  get name(): string | undefined {
    return this.device?.name;
  }

  /** Must be called from a user gesture (a click handler) - Web Bluetooth requirement. */
  async connect(): Promise<void> {
    if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth support (Chrome/Edge on desktop or Android only - not Safari or iOS).');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    const server = await this.device.gatt?.connect();
    if (!server) throw new Error('Could not open a GATT connection to the printer.');
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(WRITE_CHARACTERISTIC_UUID);
  }

  disconnect(): void {
    this.device?.gatt?.disconnect();
    this.characteristic = null;
  }

  private async write(bytes: number[]): Promise<void> {
    if (!this.characteristic) throw new Error('Not connected to a printer.');
    const data = new Uint8Array(bytes);
    for (let i = 0; i < data.length; i += CHUNK_SIZE) {
      await this.characteristic.writeValueWithoutResponse(data.slice(i, i + CHUNK_SIZE));
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

    await this.write([0x1f, 0xf0, 0x05, 0x00]);
    await this.write([0x1f, 0xf0, 0x03, 0x00]);
  }
}
