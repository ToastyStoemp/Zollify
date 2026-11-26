import { describe, expect, it } from 'vitest';
import { parseMonitor } from './statusmonitor';

describe('Canon status monitor', () => {
  it('reads the prompt while the printer waits, and the sheet it is at', () => {
    const s = parseMonitor(
      JSON.stringify({
        open: true,
        prompt: ['Starting manual feed printing.', 'Load a sheet of paper into the manual feed tray.', "Press the printer's OK button to start printing."],
        status: 'Printing from the manual feed tray.\r\nInk tank is running low.',
        document: 'Kyoto_A3.png',
        page: '5 / 6',
      }),
    );
    expect(s).toEqual({
      prompt: "Starting manual feed printing. Load a sheet of paper into the manual feed tray. Press the printer's OK button to start printing.",
      status: 'Printing from the manual feed tray. Ink tank is running low.',
      document: 'Kyoto_A3.png',
      page: { at: 5, of: 6 },
    });
  });
  it('waits for nothing once the prompt is gone', () => {
    expect(parseMonitor(JSON.stringify({ open: false, prompt: ['', '', ''], status: '', document: '', page: '' }))).toEqual({ prompt: null, status: '', document: '', page: null });
    expect(parseMonitor('not json')).toBeNull();
  });
});
