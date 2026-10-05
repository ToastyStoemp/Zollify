import { describe, expect, it } from 'vitest';
import type { CustomsState } from '../model';
import { defaultCustomsArtist, defaultCustomsEdec, defaultCustomsForm1174, defaultCustomsMeta } from '../model';
import { build1174Html } from '../form1174';

function state(artist: Partial<CustomsState['artist']>): CustomsState {
  return {
    meta: { ...defaultCustomsMeta(), event: 'Herofest', currency: 'CHF', venueStreet: 'Mingerstrasse 6', venuePostcode: '3014', venueCity: 'Bern', venueCountry: 'Switzerland' },
    artist: { ...defaultCustomsArtist(), countryOfOrigin: 'Germany', ...artist },
    edec: defaultCustomsEdec(),
    form1174: defaultCustomsForm1174(),
    products: [],
  };
}

describe('form 11.74 recipient and user', () => {
  it('box 3 names the booth care of the event, at the venue address', () => {
    const html = build1174Html(state({ companyName: 'Phuong Ninjin Studio', fullName: 'Phuong Ninjin' }));
    expect(html).toContain('Phuong Ninjin Studio\nPhuong Ninjin\nc/o Herofest\nMingerstrasse 6\n3014 Bern\nSwitzerland');
  });

  it('box 28 names the booth as the user of the goods', () => {
    const html = build1174Html(state({ companyName: 'Phuong Ninjin Studio', fullName: 'Phuong Ninjin' }));
    expect(html).toContain('<span class="fv">Phuong Ninjin Studio, Phuong Ninjin</span>');
  });

  it('without an artist name, box 3 keeps the venue alone', () => {
    const html = build1174Html(state({ companyName: '', fullName: '' }));
    expect(html).toContain('Herofest\nMingerstrasse 6\n3014 Bern\nSwitzerland');
    expect(html).not.toContain('c/o');
  });
});
