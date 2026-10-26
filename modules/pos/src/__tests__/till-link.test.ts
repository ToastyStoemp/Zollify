import { describe, expect, it } from 'vitest';
import { tillLinkFrom } from '../lib/till-link';

// As the shell hands them over: ids prefixed with the module.
const actions = [
  { moduleId: 'commissions', id: 'commissions.commission', label: 'Commission' },
  { moduleId: 'consignment', id: 'consignment.rent', label: 'Rent' },
];

describe('tillLinkFrom', () => {
  it('finds the action the query names, with its focus', () => {
    expect(tillLinkFrom({ action: 'commissions:commission', focus: 'c1' }, actions)).toEqual({ action: actions[0], focus: 'c1' });
    expect(tillLinkFrom({ action: 'consignment:rent' }, actions)).toEqual({ action: actions[1], focus: null });
    expect(tillLinkFrom({ action: ['commissions:commission'], focus: ['c2'] }, actions)?.focus).toBe('c2');
  });

  it('names nothing when the module, the action or the query is wrong', () => {
    expect(tillLinkFrom({}, actions)).toBeNull();
    expect(tillLinkFrom({ action: 'commission' }, actions)).toBeNull();
    expect(tillLinkFrom({ action: 'consignment:commission' }, actions)).toBeNull();
    expect(tillLinkFrom({ action: 'commissions:' }, actions)).toBeNull();
    expect(tillLinkFrom({ action: 'consignment:commissions.commission' }, actions)).toBeNull();
    expect(tillLinkFrom({ action: 'commissions:commission', focus: 'x'.repeat(200) }, actions)?.focus).toBeNull();
  });
});
