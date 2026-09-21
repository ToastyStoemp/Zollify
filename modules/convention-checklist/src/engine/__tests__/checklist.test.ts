import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE, groupItems, progress, type ChecklistItem } from '../checklist';

describe('DEFAULT_TEMPLATE', () => {
  it('has unique ids', () => {
    const ids = DEFAULT_TEMPLATE.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('groupItems', () => {
  const items: ChecklistItem[] = [
    { id: 'a', kind: 'supply', label: 'A' },
    { id: 'b', kind: 'supply', label: 'B', group: 'Merch' },
    { id: 'c', kind: 'supply', label: 'C' },
    { id: 'd', kind: 'supply', label: 'D', group: 'Merch' },
  ];

  it('groups in first-seen order, ungrouped items keep group: undefined', () => {
    const groups = groupItems(items);
    expect(groups.map((g) => g.group)).toEqual([undefined, 'Merch']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['b', 'd']);
  });
});

describe('progress', () => {
  it('counts checked items against the template, not the state object', () => {
    const items: ChecklistItem[] = [
      { id: 'a', kind: 'supply', label: 'A' },
      { id: 'b', kind: 'supply', label: 'B' },
      { id: 'c', kind: 'supply', label: 'C' },
    ];
    // Stale key for an item no longer in the template must not inflate the count.
    expect(progress(items, { a: true, c: true, ghost: true })).toEqual({ done: 2, total: 3 });
  });
});
