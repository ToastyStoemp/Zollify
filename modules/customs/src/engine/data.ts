/** HS code + country tables — verbatim from the legacy customs tool (www/app.js). */

export interface HsCode {
  code: string;
  desc: string;
  rate: number;
  vatRate: number;
  permit: number;
}

export const HS_CODES: HsCode[] = [
  { code: '4911.91.00', desc: 'Art prints, posters, pictures', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4909.00.00', desc: 'Printed postcards, greeting cards', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4910.00.00', desc: 'Calendars, printed', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4901.99.00', desc: 'Books, brochures, pamphlets', rate: 2.6, vatRate: 2.6, permit: 0 },
  { code: '4820.10.00', desc: 'Notebooks, albums, planners', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '3919.90.00', desc: 'Stickers, self-adhesive plastic labels', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4821.10.00', desc: 'Self-adhesive paper labels', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4202.22.00', desc: 'Handbags, tote bags (outer surface textile)', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4202.22.10', desc: 'Handbags (outer surface leather)', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4202.32.00', desc: 'Wallets, purses, key pouches', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4202.92.00', desc: 'Other bags and cases', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '7117.19.00', desc: 'Imitation jewellery, enamel pins, badges', rate: 8.1, vatRate: 8.1, permit: 2 },
  { code: '3926.90.00', desc: 'Other plastic articles, keychains, figures', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '3926.40.00', desc: 'Statuettes, decorative articles of plastic', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4016.92.00', desc: 'Floor coverings and mats of rubber, desk mats', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '6109.10.00', desc: 'T-shirts, singlets of cotton', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '6109.90.00', desc: 'T-shirts, singlets of other textile', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '6505.00.30', desc: 'Peaked caps (baseball caps)', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '9503.00.00', desc: 'Toys, puzzles, games', rate: 8.1, vatRate: 8.1, permit: 2 },
  { code: '6301.40.00', desc: 'Blankets and throws', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '6912.00.00', desc: 'Ceramic tableware, mugs', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '6913.90.00', desc: 'Ceramic statuettes and ornaments', rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '8306.29.00', desc: 'Statuettes, trophies, medals of base metal', rate: 8.1, vatRate: 8.1, permit: 0 },
];

export { COUNTRIES, COUNTRY_BY_CODE, COUNTRY_CODES } from '@zollify/shared';
