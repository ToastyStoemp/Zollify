import { describe, expect, it } from 'vitest';
import { parseCanonModel } from './supplies';

// As a Canon PRO-1000 served it, with the R tank running low.
const MODEL = `var g_Administrator = 0;
var inktank=[];
inktank[0]=[10,1,0];
inktank[1]=[12,9,1];
inktank[2]=[2,5,0];
inktank[3]=[17,8,0];
inktank[4]=[16,11,2];
var g_help_url = 'http://example';
var g_cartridge_rest = [2,0];
var g_ink_empty = '-1';`;

describe('Canon ink levels', () => {
  it('reads each tank, its level and warning, and the maintenance cartridge', () => {
    expect(parseCanonModel(MODEL)).toEqual([
      { id: 'PM', name: 'PM', kind: 'ink', level: 90, state: 'ok' },
      { id: 'R', name: 'R', kind: 'ink', level: 10, state: 'low' },
      { id: 'C', name: 'C', kind: 'ink', level: 50, state: 'ok' },
      { id: 'PGY', name: 'PGY', kind: 'ink', level: 20, state: 'ok' },
      { id: 'MBK', name: 'MBK', kind: 'ink', level: 0, state: 'out' },
      { id: 'maintenance', name: 'Maintenance cartridge', kind: 'maintenance', level: 20, state: 'ok' },
    ]);
  });
  it('leaves out a cartridge the printer has none of, and reads nothing from another page', () => {
    expect(parseCanonModel('inktank[0]=[4,0,0];\nvar g_cartridge_rest = [-1,-1];')).toEqual([{ id: 'Y', name: 'Y', kind: 'ink', level: 100, state: 'ok' }]);
    expect(parseCanonModel('<html></html>')).toEqual([]);
  });
});
