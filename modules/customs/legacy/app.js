/**
 * ZollTool -Swiss Customs Declaration Tool
 * app.js
 *
 * Vanilla JS, no dependencies.
 * Works via file:// protocol.
 */

'use strict';

/* =========================================================
   HS CODE DATABASE
   ========================================================= */
const HS_CODES = [
  { code: '4911.91.00', desc: 'Art prints, posters, pictures',                   rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4909.00.00', desc: 'Printed postcards, greeting cards',                rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4910.00.00', desc: 'Calendars, printed',                               rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4901.99.00', desc: 'Books, brochures, pamphlets',                      rate: 2.6, vatRate: 2.6, permit: 0 },
  { code: '4820.10.00', desc: 'Notebooks, albums, planners',                      rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '3919.90.00', desc: 'Stickers, self-adhesive plastic labels',           rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4821.10.00', desc: 'Self-adhesive paper labels',                       rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4202.22.00', desc: 'Handbags, tote bags (outer surface textile)',      rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4202.22.10', desc: 'Handbags (outer surface leather)',                 rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4202.32.00', desc: 'Wallets, purses, key pouches',                    rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4202.92.00', desc: 'Other bags and cases',                             rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '7117.19.00', desc: 'Imitation jewellery, enamel pins, badges',        rate: 8.1, vatRate: 8.1, permit: 2 },
  { code: '3926.90.00', desc: 'Other plastic articles, keychains, figures',      rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '3926.40.00', desc: 'Statuettes, decorative articles of plastic',      rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '4016.92.00', desc: 'Floor coverings and mats of rubber, desk mats',   rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '6109.10.00', desc: 'T-shirts, singlets of cotton',                    rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '6109.90.00', desc: 'T-shirts, singlets of other textile',             rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '9503.00.00', desc: 'Toys, puzzles, games',                            rate: 8.1, vatRate: 8.1, permit: 2 },
  { code: '6301.40.00', desc: 'Blankets and throws',                             rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '6912.00.00', desc: 'Ceramic tableware, mugs',                         rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '6913.90.00', desc: 'Ceramic statuettes and ornaments',                rate: 8.1, vatRate: 8.1, permit: 0 },
  { code: '8306.29.00', desc: 'Statuettes, trophies, medals of base metal',      rate: 8.1, vatRate: 8.1, permit: 0 },
];

const COUNTRIES = [
  { code: 'AF', name: 'Afghanistan' },
  { code: 'AL', name: 'Albania' },
  { code: 'DZ', name: 'Algeria' },
  { code: 'AD', name: 'Andorra' },
  { code: 'AO', name: 'Angola' },
  { code: 'AG', name: 'Antigua and Barbuda' },
  { code: 'AR', name: 'Argentina' },
  { code: 'AM', name: 'Armenia' },
  { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria' },
  { code: 'AZ', name: 'Azerbaijan' },
  { code: 'BS', name: 'Bahamas' },
  { code: 'BH', name: 'Bahrain' },
  { code: 'BD', name: 'Bangladesh' },
  { code: 'BB', name: 'Barbados' },
  { code: 'BY', name: 'Belarus' },
  { code: 'BE', name: 'Belgium' },
  { code: 'BZ', name: 'Belize' },
  { code: 'BJ', name: 'Benin' },
  { code: 'BT', name: 'Bhutan' },
  { code: 'BO', name: 'Bolivia' },
  { code: 'BA', name: 'Bosnia and Herzegovina' },
  { code: 'BW', name: 'Botswana' },
  { code: 'BR', name: 'Brazil' },
  { code: 'BN', name: 'Brunei' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'BF', name: 'Burkina Faso' },
  { code: 'BI', name: 'Burundi' },
  { code: 'CV', name: 'Cabo Verde' },
  { code: 'KH', name: 'Cambodia' },
  { code: 'CM', name: 'Cameroon' },
  { code: 'CA', name: 'Canada' },
  { code: 'CF', name: 'Central African Republic' },
  { code: 'TD', name: 'Chad' },
  { code: 'CL', name: 'Chile' },
  { code: 'CN', name: 'China' },
  { code: 'CO', name: 'Colombia' },
  { code: 'KM', name: 'Comoros' },
  { code: 'CG', name: 'Congo' },
  { code: 'CD', name: 'Congo (DR)' },
  { code: 'CR', name: 'Costa Rica' },
  { code: 'CI', name: 'Côte d\'Ivoire' },
  { code: 'HR', name: 'Croatia' },
  { code: 'CU', name: 'Cuba' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'DK', name: 'Denmark' },
  { code: 'DJ', name: 'Djibouti' },
  { code: 'DM', name: 'Dominica' },
  { code: 'DO', name: 'Dominican Republic' },
  { code: 'EC', name: 'Ecuador' },
  { code: 'EG', name: 'Egypt' },
  { code: 'SV', name: 'El Salvador' },
  { code: 'GQ', name: 'Equatorial Guinea' },
  { code: 'ER', name: 'Eritrea' },
  { code: 'EE', name: 'Estonia' },
  { code: 'SZ', name: 'Eswatini' },
  { code: 'ET', name: 'Ethiopia' },
  { code: 'FJ', name: 'Fiji' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'GA', name: 'Gabon' },
  { code: 'GM', name: 'Gambia' },
  { code: 'GE', name: 'Georgia' },
  { code: 'DE', name: 'Germany' },
  { code: 'GH', name: 'Ghana' },
  { code: 'GR', name: 'Greece' },
  { code: 'GD', name: 'Grenada' },
  { code: 'GT', name: 'Guatemala' },
  { code: 'GN', name: 'Guinea' },
  { code: 'GW', name: 'Guinea-Bissau' },
  { code: 'GY', name: 'Guyana' },
  { code: 'HT', name: 'Haiti' },
  { code: 'HN', name: 'Honduras' },
  { code: 'HU', name: 'Hungary' },
  { code: 'IS', name: 'Iceland' },
  { code: 'IN', name: 'India' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'IR', name: 'Iran' },
  { code: 'IQ', name: 'Iraq' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IL', name: 'Israel' },
  { code: 'IT', name: 'Italy' },
  { code: 'JM', name: 'Jamaica' },
  { code: 'JP', name: 'Japan' },
  { code: 'JO', name: 'Jordan' },
  { code: 'KZ', name: 'Kazakhstan' },
  { code: 'KE', name: 'Kenya' },
  { code: 'KI', name: 'Kiribati' },
  { code: 'KP', name: 'Korea (North)' },
  { code: 'KR', name: 'Korea (South)' },
  { code: 'KW', name: 'Kuwait' },
  { code: 'KG', name: 'Kyrgyzstan' },
  { code: 'LA', name: 'Laos' },
  { code: 'LV', name: 'Latvia' },
  { code: 'LB', name: 'Lebanon' },
  { code: 'LS', name: 'Lesotho' },
  { code: 'LR', name: 'Liberia' },
  { code: 'LY', name: 'Libya' },
  { code: 'LI', name: 'Liechtenstein' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'MG', name: 'Madagascar' },
  { code: 'MW', name: 'Malawi' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'MV', name: 'Maldives' },
  { code: 'ML', name: 'Mali' },
  { code: 'MT', name: 'Malta' },
  { code: 'MH', name: 'Marshall Islands' },
  { code: 'MR', name: 'Mauritania' },
  { code: 'MU', name: 'Mauritius' },
  { code: 'MX', name: 'Mexico' },
  { code: 'FM', name: 'Micronesia' },
  { code: 'MD', name: 'Moldova' },
  { code: 'MC', name: 'Monaco' },
  { code: 'MN', name: 'Mongolia' },
  { code: 'ME', name: 'Montenegro' },
  { code: 'MA', name: 'Morocco' },
  { code: 'MZ', name: 'Mozambique' },
  { code: 'MM', name: 'Myanmar' },
  { code: 'NA', name: 'Namibia' },
  { code: 'NR', name: 'Nauru' },
  { code: 'NP', name: 'Nepal' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'NI', name: 'Nicaragua' },
  { code: 'NE', name: 'Niger' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'MK', name: 'North Macedonia' },
  { code: 'NO', name: 'Norway' },
  { code: 'OM', name: 'Oman' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'PW', name: 'Palau' },
  { code: 'PS', name: 'Palestine' },
  { code: 'PA', name: 'Panama' },
  { code: 'PG', name: 'Papua New Guinea' },
  { code: 'PY', name: 'Paraguay' },
  { code: 'PE', name: 'Peru' },
  { code: 'PH', name: 'Philippines' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'QA', name: 'Qatar' },
  { code: 'RO', name: 'Romania' },
  { code: 'RU', name: 'Russia' },
  { code: 'RW', name: 'Rwanda' },
  { code: 'KN', name: 'Saint Kitts and Nevis' },
  { code: 'LC', name: 'Saint Lucia' },
  { code: 'VC', name: 'Saint Vincent and the Grenadines' },
  { code: 'WS', name: 'Samoa' },
  { code: 'SM', name: 'San Marino' },
  { code: 'ST', name: 'São Tomé and Príncipe' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'SN', name: 'Senegal' },
  { code: 'RS', name: 'Serbia' },
  { code: 'SC', name: 'Seychelles' },
  { code: 'SL', name: 'Sierra Leone' },
  { code: 'SG', name: 'Singapore' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'SB', name: 'Solomon Islands' },
  { code: 'SO', name: 'Somalia' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'SS', name: 'South Sudan' },
  { code: 'ES', name: 'Spain' },
  { code: 'LK', name: 'Sri Lanka' },
  { code: 'SD', name: 'Sudan' },
  { code: 'SR', name: 'Suriname' },
  { code: 'SE', name: 'Sweden' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'SY', name: 'Syria' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'TJ', name: 'Tajikistan' },
  { code: 'TZ', name: 'Tanzania' },
  { code: 'TH', name: 'Thailand' },
  { code: 'TL', name: 'Timor-Leste' },
  { code: 'TG', name: 'Togo' },
  { code: 'TO', name: 'Tonga' },
  { code: 'TT', name: 'Trinidad and Tobago' },
  { code: 'TN', name: 'Tunisia' },
  { code: 'TR', name: 'Turkey' },
  { code: 'TM', name: 'Turkmenistan' },
  { code: 'TV', name: 'Tuvalu' },
  { code: 'UG', name: 'Uganda' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'UY', name: 'Uruguay' },
  { code: 'UZ', name: 'Uzbekistan' },
  { code: 'VU', name: 'Vanuatu' },
  { code: 'VE', name: 'Venezuela' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'YE', name: 'Yemen' },
  { code: 'ZM', name: 'Zambia' },
  { code: 'ZW', name: 'Zimbabwe' },
];

// Build lookup maps from COUNTRIES
const COUNTRY_BY_CODE = Object.fromEntries(COUNTRIES.map(c => [c.code, c.name]));
const COUNTRY_CODES = Object.fromEntries(
  COUNTRIES.flatMap(c => [
    [c.name.toLowerCase(), c.code],
    [c.code.toLowerCase(), c.code],
  ])
);

/* =========================================================
   STATE
   ========================================================= */
const DEFAULT_STATE = {
  meta: {
    event:           '',
    eventDateStart:  '',
    eventDateEnd:    '',
    eventLocation:   '',
    companyCode:     '',
    lrp:             '',
    documentNumber:  1,
    venueName:       '',
    venueStreet:     '',
    venuePostcode:   '',
    venueCity:       '',
    venueCountry:    'Switzerland',
    venueTIN:        'CHE222251936',
    currency:        'CHF',
  },
  artist: {
    companyName:     '',
    fullName:        '',
    street:          '',
    postCodeCity:    '',
    countryOfOrigin: '',
    phone:           '',
    email:           '',
  },
  edec: {
    transportMode:          '3',
    transportationType:     '1',
    transportationCountry:    '',
    transportationNumber:     '',
    flightNumber:             '',
    registrationPostcode:     '',
    importerCountry:          'CH',
  },
  form1174: {
    groupMode: 'auto',    // 'auto' | 'manual'
    assignments: [],      // parallel array to state.products: 1=group1, 2=group2, 0=unassigned(→group2)
  },
  products: [],
  transactions: [],       // POS sale log: [{ id, timestamp, method, total, currency, reverted, revertedAt, items }]
};

let state = deepClone(DEFAULT_STATE);
let fpStart = null, fpEnd = null;

// UUID helper (works in file:// context)
function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* =========================================================
   PERSISTENCE
   ========================================================= */
const STORAGE_KEY = 'zolltool_state_v1';

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // Storage might not be available on some file:// contexts
    console.warn('LocalStorage not available:', e);
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Merge carefully to handle schema changes
      state = {
        meta:         Object.assign({}, DEFAULT_STATE.meta,     parsed.meta     || {}),
        artist:       Object.assign({}, DEFAULT_STATE.artist,   parsed.artist   || {}),
        edec:         Object.assign({}, DEFAULT_STATE.edec,     parsed.edec     || {}),
        products:     Array.isArray(parsed.products)     ? parsed.products     : [],
        form1174:     Object.assign({}, DEFAULT_STATE.form1174, parsed.form1174 || {}),
        discounts:    Array.isArray(parsed.discounts)    ? parsed.discounts    : [],
        transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      };
      if (!Array.isArray(state.form1174.assignments)) state.form1174.assignments = [];
      // Ensure fields added in later schema versions are never left empty
      if (!state.meta.venueTIN) state.meta.venueTIN = DEFAULT_STATE.meta.venueTIN;
    }
  } catch (e) {
    console.warn('Could not restore from localStorage:', e);
  }
}

/* =========================================================
   DOM HELPERS
   ========================================================= */
function $(sel, ctx) { return (ctx || document).querySelector(sel); }
function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') { node.className = v; }
      else if (k === 'data') { Object.entries(v).forEach(([dk, dv]) => node.dataset[dk] = dv); }
      else if (k.startsWith('on')) { node.addEventListener(k.slice(2), v); }
      else { node.setAttribute(k, v); }
    });
  }
  children.forEach(child => {
    if (child == null) return;
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(child));
    } else {
      node.appendChild(child);
    }
  });
  return node;
}

/* =========================================================
   FORMATTING
   ========================================================= */
function fmtEventDates(start, end) {
  // Returns e.g. "14. – 16.05.2026" from ISO date strings
  if (!start) return '';
  const s = new Date(start + 'T00:00:00');
  const d1 = s.getDate();
  const mm = String(s.getMonth() + 1).padStart(2, '0');
  const yyyy = s.getFullYear();
  if (!end) return `${d1}.${mm}.${yyyy}`;
  const e = new Date(end + 'T00:00:00');
  const d2 = e.getDate();
  return `${d1}. \u2013 ${d2}.${mm}.${yyyy}`;
}

function fmtWeight(grams) {
  if (grams == null || grams === '' || isNaN(grams)) return '—';
  const kg = grams / 1000;
  if (kg < 0.001) return grams + ' g';
  return formatNum(kg, 3).replace('.', ',') + ' kg';
}

function fmtWeightKg(kg) {
  if (kg == null || isNaN(kg) || kg === 0) return '0 kg';
  return formatNum(kg, 2).replace('.', ',') + ' kg';
}

function getCurrency() {
  return (state.meta && state.meta.currency) ? state.meta.currency : 'CHF';
}

function fmtCHF(val) {
  if (val == null || isNaN(val)) return '—';
  return getCurrency() + ' ' + formatNum(val, 2);
}

function formatNum(n, decimals) {
  return parseFloat(n).toFixed(decimals);
}

function floorN(value, decimals) {
  if (value == null || isNaN(value)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.floor(parseFloat(value) * factor) / factor;
}

function fmtRate(r) {
  if (r == null || r === '' || isNaN(r)) return '—';
  return parseFloat(r).toFixed(1) + '%';
}

/* =========================================================
   VARIANT HELPERS
   ========================================================= */
function hasVariants(p) {
  return Array.isArray(p.variants) && p.variants.length > 0;
}
function variantPrice(p, v) {
  const raw = (v.price != null && v.price !== '') ? v.price : p.price;
  return (raw != null && !isNaN(parseFloat(raw))) ? parseFloat(raw) : null;
}
function variantWeight(p, v) {
  const raw = (v.weightG != null && v.weightG !== '') ? v.weightG : p.weightG;
  return parseFloat(raw) || 0;
}

/* =========================================================
   CALCULATIONS
   ========================================================= */
function calcProduct(p, skipUnlistedVariants = false) {
  if (hasVariants(p)) {
    let amount = 0, totalWeightKg = 0, totalValue = 0;
    let soldQty = 0, soldValue = 0, soldWeightKg = 0;
    for (const v of p.variants) {
      if (skipUnlistedVariants && v.unlisted) continue;
      const amt   = v.amount || 0;
      const wg    = variantWeight(p, v);
      const price = variantPrice(p, v);
      amount        += amt;
      totalWeightKg += Math.round(amt * wg) / 1000;
      if (price != null) totalValue += price * amt;
      soldQty       += v.soldQty   || 0;
      soldValue     += v.soldValue || 0;
      soldWeightKg  += (v.soldQty || 0) * wg / 1000;
    }
    totalWeightKg = Math.round(totalWeightKg * 1000) / 1000;
    const activeVariants = skipUnlistedVariants ? p.variants.filter(v => !v.unlisted) : p.variants;
    const prices  = activeVariants.map(v => variantPrice(p, v)).filter(x => x != null);
    const weights = activeVariants.map(v => variantWeight(p, v));
    const allSamePrice  = prices.length  > 0 && prices.every(x => x === prices[0]);
    const allSameWeight = weights.length > 0 && weights.every(x => x === weights[0]);
    const effectiveUnitPrice  = allSamePrice  ? prices[0]
      : (amount > 0 && totalValue > 0 ? totalValue / amount : null);
    const effectiveUnitWeightG = allSameWeight ? weights[0]
      : (amount > 0 ? Math.round(totalWeightKg * 1000 / amount) : (p.weightG || 0));
    return {
      totalWeightKg,
      totalValue:           totalValue > 0 ? Math.round(totalValue) : null,
      effectiveUnitPrice,
      effectiveUnitWeightG,
      soldWeightKg,
      amount, soldQty, soldValue,
    };
  }

  const amount = p.amount || 0;
  // Weight: round to nearest gram first to eliminate floating-point noise, then convert to kg
  const totalWeightKg = Math.round(amount * (p.weightG || 0)) / 1000;
  // Value: round to whole CHF — the total is the authoritative number
  let totalValue = p.totalValueCHF != null ? Math.round(parseFloat(p.totalValueCHF)) : null;
  if (totalValue == null && p.price != null && p.price !== '') {
    totalValue = Math.round(parseFloat(p.price) * amount);
  }
  // Effective per-unit values derived from the rounded totals (not from raw stored inputs)
  const effectiveUnitPrice   = (totalValue != null && amount > 0) ? totalValue / amount : null;
  const effectiveUnitWeightG = amount > 0 ? (totalWeightKg * 1000) / amount : (p.weightG || 0);
  const soldWeightKg = (p.soldQty || 0) * (p.weightG || 0) / 1000;
  return {
    totalWeightKg, totalValue, effectiveUnitPrice, effectiveUnitWeightG, soldWeightKg,
    amount, soldQty: p.soldQty || 0, soldValue: p.soldValue || 0,
  };
}

// Returns { retQty, retWkg, retVal } for the unsold/return portion of a product.
// For variant products, sums per-variant (exact); for plain products, uses calcProduct totals.
// Unlisted variants are excluded from both qty and value.
function calcReturnStats(p) {
  if (hasVariants(p)) {
    let retQty = 0, retWkg = 0, retVal = 0, hasVal = false;
    for (const v of p.variants) {
      if (v.unlisted) continue;
      const vRet = (v.amount || 0) - (v.soldQty || 0);
      if (vRet <= 0) continue;
      const wg    = variantWeight(p, v);
      const price = variantPrice(p, v);
      retQty += vRet;
      retWkg += Math.round(vRet * wg) / 1000;
      if (price != null) { retVal += Math.round(price * vRet); hasVal = true; }
    }
    return { retQty, retWkg: Math.round(retWkg * 1000) / 1000, retVal: hasVal ? retVal : null };
  }
  const c = calcProduct(p);
  const retQty = (c.amount || 0) - (c.soldQty || 0);
  if (retQty <= 0) return { retQty: 0, retWkg: 0, retVal: null };
  const retWkg = Math.round(retQty * (p.weightG || 0)) / 1000;
  const retVal = c.effectiveUnitPrice != null ? Math.round(c.effectiveUnitPrice * retQty) : null;
  return { retQty, retWkg, retVal };
}

function calcTotals() {
  function aggregate(products, customsMode = false) {
    let totalAmount = 0, totalWeightKg = 0, totalValue = 0;
    let totalSoldQty = 0, totalSoldVal = 0, totalSoldVat = 0, totalSoldWeight = 0;
    let totalImportVat = 0;
    const byTariffRate = {};
    products.forEach(p => {
      const c = calcProduct(p, customsMode);
      totalAmount     += c.amount;
      totalWeightKg   += c.totalWeightKg;
      if (c.totalValue != null) totalValue += c.totalValue;
      totalSoldQty    += c.soldQty;
      totalSoldVal    += c.soldValue;
      totalSoldVat    += floorN(c.soldValue * ((p.vatRate || 0) / 100), 2);
      totalSoldWeight += c.soldWeightKg;
      if (c.totalValue != null) totalImportVat += floorN(c.totalValue * ((p.vatRate || 0) / 100), 2);
      const rateKey = p.tariffRate != null ? String(parseFloat(p.tariffRate)) : '?';
      if (!byTariffRate[rateKey]) byTariffRate[rateKey] = { value: 0, soldVal: 0 };
      if (c.totalValue != null) byTariffRate[rateKey].value += c.totalValue;
      byTariffRate[rateKey].soldVal += c.soldValue;
    });
    return { totalAmount, totalWeightKg, totalValue, totalImportVat, totalSoldQty, totalSoldVal, totalSoldVat, totalSoldWeight, byTariffRate };
  }

  const all      = aggregate(state.products);
  const customs  = aggregate(state.products.filter(p => !p.unlisted), true);
  const hasUnlisted = state.products.some(p => p.unlisted || (p.variants || []).some(v => v.unlisted));
  return { ...all, customs, hasUnlisted };
}

/* =========================================================
   COLLAPSIBLE SECTIONS
   ========================================================= */
function initCollapsibles() {
  $$('.collapsible-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const targetId = toggle.dataset.target;
      const body = document.getElementById(targetId);
      const chevronId = 'chevron-' + targetId.replace('-body', '');
      const chevron = document.getElementById(chevronId);
      const isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      if (chevron) chevron.classList.toggle('open', !isOpen);
    });
  });
}

function updateSectionSummaries() {
  // Event summary
  const m = state.meta;
  const datesStr = fmtEventDates(m.eventDateStart, m.eventDateEnd);
  const eventParts = [m.event, datesStr, m.eventLocation].filter(Boolean);
  const eventSummary = document.getElementById('event-summary');
  if (eventSummary) {
    eventSummary.textContent = eventParts.length
      ? eventParts.join(' · ')
      : 'Click to expand';
  }

  // Artist summary
  const a = state.artist;
  const artistParts = [a.fullName || a.companyName, a.countryOfOrigin].filter(Boolean);
  const artistSummary = document.getElementById('artist-summary');
  if (artistSummary) {
    artistSummary.textContent = artistParts.length
      ? artistParts.join(' · ')
      : 'Click to expand';
  }

  renderPermitOverrides();

  // E-dec summary
  const edecSummary = document.getElementById('edec-summary');
  if (edecSummary) {
    const hasSoldItems = state.products.some(p => !p.unlisted && ((p.soldQty || 0) > 0 || (p.variants || []).some(v => (v.soldQty || 0) > 0)));
    const hasTransport = state.edec.transportationNumber;
    if (hasSoldItems && hasTransport) {
      edecSummary.textContent = 'Ready to generate XML';
      edecSummary.style.color = '#1a7a3e';
    } else if (hasSoldItems) {
      edecSummary.textContent = 'Sold quantities entered - complete transport & importer info';
      edecSummary.style.color = '';
    } else {
      edecSummary.textContent = 'Complete after the event - enter sold quantities first';
      edecSummary.style.color = '';
    }
  }
}

/* =========================================================
   FORM FIELD BINDING
   ========================================================= */
function bindFormFields() {
  $$('[data-key]').forEach(input => {
    const key = input.dataset.key;
    const [section, field] = key.split('.');

    // Set initial value
    if (state[section] && state[section][field] != null) {
      input.value = state[section][field];
    }

    // Listen for changes -use both 'input' and 'change' to cover inputs and selects
    const handler = () => {
      if (!state[section]) state[section] = {};
      state[section][field] = input.value;
      updateSectionSummaries();
      saveToStorage();
      // Re-render table and totals when currency changes so labels update immediately
      if (section === 'meta' && field === 'currency') {
        renderTable();
        renderTotals();
        updateRouteGuidance();
      }
      if (section === 'meta' && field === 'venueCountry') {

      }
    };
    input.addEventListener('input', handler);
    input.addEventListener('change', handler);
  });
}

/* =========================================================
   PRODUCT TABLE RENDERING
   ========================================================= */
function renderTable() {
  const tbody = document.getElementById('products-tbody');
  const emptyState = document.getElementById('empty-state');

  tbody.innerHTML = '';

  if (state.products.length === 0) {
    emptyState.classList.add('visible');
  } else {
    emptyState.classList.remove('visible');

    state.products.forEach((p, idx) => {
      const row = buildProductRow(p, idx);
      tbody.appendChild(row);
      
      // If product has variants, add variant rows
      if (hasVariants(p)) {
        p.variants.forEach(v => {
          const variantRow = buildVariantRow(p, v);
          tbody.appendChild(variantRow);
        });
      }
    });
  }

  renderTotals();
  if (document.getElementById('group-auto-info')) render1174GroupUI();
}

function buildProductRow(p, idx) {
  const c = calcProduct(p);
  const tr = document.createElement('tr');
  tr.dataset.id = p.id;

  // Helper to make a TD
  const td = (cls, content) => {
    const cell = document.createElement('td');
    if (cls) cell.className = cls;
    if (content instanceof Node) {
      cell.appendChild(content);
    } else if (content != null) {
      cell.textContent = content;
    }
    return cell;
  };

  // Drag handle
  const handleCell = document.createElement('td');
  handleCell.className = 'col-handle';
  handleCell.innerHTML = '<span class="drag-handle" title="Drag to reorder">&#8942;</span>';
  tr.insertBefore(handleCell, tr.firstChild);
  tr.draggable = true;

  // # -row number
  tr.appendChild(td('col-num', idx + 1));

  // Title
  const titleCell = document.createElement('td');
  titleCell.className = 'col-title';
  if (hasVariants(p)) {
    const titleDiv = document.createElement('div');
    titleDiv.className = 'product-title-with-expand';
    const expandBtn = document.createElement('button');
    expandBtn.className = 'variant-expand-btn';
    expandBtn.title = 'Toggle variants';
    expandBtn.innerHTML = '▼';
    expandBtn.dataset.expanded = 'false';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = expandBtn.dataset.expanded === 'true';
      expandBtn.dataset.expanded = !expanded;
      expandBtn.classList.toggle('expanded');
      const variantRows = document.querySelectorAll(`tr.variant-row[data-parent-id="${p.id}"]`);
      variantRows.forEach(vr => {
        vr.style.display = expanded ? 'none' : '';
      });
    });
    titleDiv.appendChild(expandBtn);
    const titleSpan = document.createElement('span');
    titleSpan.textContent = p.title || '—';
    titleDiv.appendChild(titleSpan);
    titleCell.appendChild(titleDiv);
  } else {
    titleCell.textContent = p.title || '—';
  }
  tr.appendChild(titleCell);

  // SKU
  tr.appendChild(td('col-sku', p.sku || '—'));

  // For Sale badge (+ Unlisted indicator)
  const saleBadge = document.createElement('span');
  saleBadge.className = p.forSale ? 'badge badge-sale' : 'badge badge-nosale';
  saleBadge.textContent = p.forSale ? 'For Sale' : 'Not For Sale';
  const saleCell = document.createElement('td');
  saleCell.className = 'col-sale';
  saleCell.appendChild(saleBadge);
  if (p.unlisted) {
    const unlistedBadge = document.createElement('span');
    unlistedBadge.className = 'badge badge-unlisted';
    unlistedBadge.textContent = 'Unlisted';
    unlistedBadge.title = 'Excluded from all customs documents';
    saleCell.appendChild(unlistedBadge);
  }
  tr.appendChild(saleCell);

  // Type
  tr.appendChild(td('col-type', p.type || '—'));

  // Amount
  const amtCell = document.createElement('td');
  amtCell.className = 'col-amount';
  amtCell.style.textAlign = 'right';
  amtCell.textContent = c.amount != null ? c.amount.toLocaleString() : '—';
  tr.appendChild(amtCell);

  // Unit weight
  const uwCell = document.createElement('td');
  uwCell.className = 'col-weight';
  uwCell.style.textAlign = 'right';
  uwCell.textContent = p.weightG != null ? p.weightG + ' g' : '—';
  tr.appendChild(uwCell);

  // Total weight
  const twCell = document.createElement('td');
  twCell.className = 'col-totalweight';
  twCell.style.textAlign = 'right';
  twCell.textContent = fmtWeightKg(c.totalWeightKg);
  tr.appendChild(twCell);

  // Unit price
  const priceCell = document.createElement('td');
  priceCell.className = 'col-price';
  priceCell.style.textAlign = 'right';
  if (p.priceNote) {
    const note = document.createElement('span');
    note.className = 'price-note';
    note.textContent = p.priceNote;
    priceCell.appendChild(note);
  } else if (c.effectiveUnitPrice != null) {
    // Show per-unit derived from rounded total so it stays consistent with the total column
    priceCell.textContent = getCurrency() + ' ' + formatNum(floorN(c.effectiveUnitPrice, 2), 2);
  } else {
    priceCell.textContent = '—';
  }
  tr.appendChild(priceCell);

  // Total value CHF -already a whole CHF from calcProduct
  const valCell = document.createElement('td');
  valCell.className = 'col-totalval';
  valCell.style.textAlign = 'right';
  if (c.totalValue != null) {
    valCell.textContent = getCurrency() + ' ' + c.totalValue;
  } else {
    valCell.textContent = '—';
  }
  tr.appendChild(valCell);

  // Tariff No.
  const tariffCell = document.createElement('td');
  tariffCell.className = 'col-tariff';
  if (p.tariffNo) {
    const span = document.createElement('span');
    span.className = 'tariff-code';
    span.textContent = p.tariffNo;
    tariffCell.appendChild(span);
  } else {
    tariffCell.textContent = '—';
  }
  tr.appendChild(tariffCell);

  // Tariff Rate
  const trCell = document.createElement('td');
  trCell.className = 'col-tariffrate';
  trCell.style.textAlign = 'right';
  trCell.textContent = fmtRate(p.tariffRate);
  tr.appendChild(trCell);

  // VAT Rate
  const vatCell = document.createElement('td');
  vatCell.className = 'col-vat';
  vatCell.style.textAlign = 'right';
  vatCell.textContent = fmtRate(p.vatRate);
  tr.appendChild(vatCell);

  // Origin Country
  const effectiveOrigin = (p.originCountry && p.originCountry.trim())
    ? p.originCountry.trim().toUpperCase()
    : countryToCode(state.artist.countryOfOrigin) || '—';
  tr.appendChild(td('col-origin', effectiveOrigin));

  // --- Sold columns ---
  const soldQtyCell = document.createElement('td');
  soldQtyCell.className = 'col-soldqty sold-col-start';
  soldQtyCell.style.textAlign = 'right';

  const soldValCell = document.createElement('td');
  soldValCell.className = 'col-soldval';
  soldValCell.style.textAlign = 'right';

  if (hasVariants(p)) {
    // Variant products: sold data is per-variant, show aggregate as read-only
    soldQtyCell.textContent = c.soldQty;
    soldValCell.textContent = formatNum(c.soldValue, 2);
  } else {
    // Sold Qty (editable)
    const soldQtyInput = document.createElement('input');
    soldQtyInput.type = 'number';
    soldQtyInput.className = 'sold-input';
    soldQtyInput.min = '0';
    soldQtyInput.step = '1';
    soldQtyInput.value = p.soldQty != null ? p.soldQty : 0;
    soldQtyInput.addEventListener('change', () => {
      updateProductField(p.id, 'soldQty', parseFloat(soldQtyInput.value) || 0);
    });
    soldQtyCell.appendChild(soldQtyInput);

    // Sold Value (editable)
    const soldValInput = document.createElement('input');
    soldValInput.type = 'number';
    soldValInput.className = 'sold-input';
    soldValInput.min = '0';
    soldValInput.step = '0.01';
    soldValInput.value = p.soldValue != null ? formatNum(p.soldValue, 2) : '0.00';
    soldValInput.addEventListener('change', () => {
      updateProductField(p.id, 'soldValue', parseFloat(soldValInput.value) || 0);
    });
    soldValCell.appendChild(soldValInput);
  }

  tr.appendChild(soldQtyCell);
  tr.appendChild(soldValCell);

  // Sold VAT (derived, read-only)
  const soldVatCell = document.createElement('td');
  soldVatCell.className = 'col-soldvat';
  soldVatCell.style.textAlign = 'right';
  soldVatCell.textContent = formatNum(floorN(c.soldValue * ((p.vatRate || 0) / 100), 2), 2);
  tr.appendChild(soldVatCell);

  // Sold Weight (derived, read-only display)
  const soldWtCell = document.createElement('td');
  soldWtCell.className = 'col-soldweight';
  soldWtCell.style.textAlign = 'right';
  soldWtCell.textContent = fmtWeightKg(c.soldWeightKg);
  tr.appendChild(soldWtCell);

  // Actions
  const actionsCell = document.createElement('td');
  actionsCell.className = 'col-actions';
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'row-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-ghost btn-icon';
  editBtn.title = 'Edit';
  editBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  editBtn.addEventListener('click', () => openEditModal(p.id));

  const dupBtn = document.createElement('button');
  dupBtn.className = 'btn btn-ghost btn-icon';
  dupBtn.title = 'Duplicate';
  dupBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  dupBtn.addEventListener('click', () => duplicateProduct(p.id));

  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-danger btn-icon';
  delBtn.title = 'Delete';
  delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
  delBtn.addEventListener('click', () => deleteProduct(p.id));

  actionsDiv.appendChild(editBtn);
  actionsDiv.appendChild(dupBtn);
  actionsDiv.appendChild(delBtn);
  actionsCell.appendChild(actionsDiv);
  tr.appendChild(actionsCell);

  return tr;
}

function buildVariantRow(parentProduct, variant) {
  const tr = document.createElement('tr');
  tr.className = 'variant-row';
  tr.dataset.parentId = parentProduct.id;
  tr.dataset.variantId = variant.id;
  tr.style.display = 'none'; // Hidden by default

  const td = (cls, content) => {
    const cell = document.createElement('td');
    if (cls) cell.className = cls;
    if (content instanceof Node) {
      cell.appendChild(content);
    } else if (content != null) {
      cell.textContent = content;
    }
    return cell;
  };

  // Empty handle cell for variant
  tr.appendChild(td('col-handle', ''));
  
  // Empty number cell for variant
  tr.appendChild(td('col-num', ''));

  // Variant name with indent
  const nameCell = document.createElement('td');
  nameCell.className = 'col-title variant-title';
  nameCell.textContent = '→ ' + (variant.name || '—');
  tr.appendChild(nameCell);

  // Variant SKU
  tr.appendChild(td('col-sku', variant.sku || '—'));

  // For Sale (inherited from parent) + optional variant-level Unlisted badge
  const saleBadge = document.createElement('span');
  saleBadge.className = parentProduct.forSale ? 'badge badge-sale' : 'badge badge-nosale';
  saleBadge.textContent = parentProduct.forSale ? 'For Sale' : 'Not For Sale';
  const saleCell = document.createElement('td');
  saleCell.className = 'col-sale';
  saleCell.appendChild(saleBadge);
  if (variant.unlisted) {
    const unlistedBadge = document.createElement('span');
    unlistedBadge.className = 'badge badge-unlisted';
    unlistedBadge.textContent = 'Unlisted';
    unlistedBadge.title = 'This variant is excluded from customs documents';
    saleCell.appendChild(unlistedBadge);
  }
  tr.appendChild(saleCell);

  // Type (inherited from parent)
  tr.appendChild(td('col-type', parentProduct.type || '—'));

  // Amount (variant-specific)
  const amtCell = document.createElement('td');
  amtCell.className = 'col-amount';
  amtCell.style.textAlign = 'right';
  amtCell.textContent = (variant.amount || 0).toLocaleString();
  tr.appendChild(amtCell);

  // Unit weight (variant-specific)
  const uwCell = document.createElement('td');
  uwCell.className = 'col-weight';
  uwCell.style.textAlign = 'right';
  const varWg = variant.weightG != null ? variant.weightG : parentProduct.weightG;
  uwCell.textContent = varWg != null ? varWg + ' g' : '—';
  tr.appendChild(uwCell);

  // Total weight
  const twCell = document.createElement('td');
  twCell.className = 'col-totalweight';
  twCell.style.textAlign = 'right';
  const totalWeightKg = Math.round((variant.amount || 0) * (varWg || 0)) / 1000;
  twCell.textContent = fmtWeightKg(totalWeightKg);
  tr.appendChild(twCell);

  // Unit price (variant-specific)
  const priceCell = document.createElement('td');
  priceCell.className = 'col-price';
  priceCell.style.textAlign = 'right';
  const varPrice = variant.price != null ? variant.price : parentProduct.price;
  if (parentProduct.priceNote) {
    const note = document.createElement('span');
    note.className = 'price-note';
    note.textContent = parentProduct.priceNote;
    priceCell.appendChild(note);
  } else if (varPrice != null) {
    priceCell.textContent = getCurrency() + ' ' + formatNum(floorN(varPrice, 2), 2);
  } else {
    priceCell.textContent = '—';
  }
  tr.appendChild(priceCell);

  // Total value
  const valCell = document.createElement('td');
  valCell.className = 'col-totalval';
  valCell.style.textAlign = 'right';
  const totalVal = varPrice != null ? Math.round(varPrice * (variant.amount || 0)) : null;
  valCell.textContent = totalVal != null ? getCurrency() + ' ' + totalVal : '—';
  tr.appendChild(valCell);

  // Tariff No. (inherited from parent)
  const tariffCell = document.createElement('td');
  tariffCell.className = 'col-tariff';
  if (parentProduct.tariffNo) {
    const span = document.createElement('span');
    span.className = 'tariff-code';
    span.textContent = parentProduct.tariffNo;
    tariffCell.appendChild(span);
  } else {
    tariffCell.textContent = '—';
  }
  tr.appendChild(tariffCell);

  // Tariff Rate (inherited from parent)
  tr.appendChild(td('col-tariffrate', parentProduct.tariffRate != null ? parentProduct.tariffRate + '%' : '—'));

  // VAT Rate (inherited from parent)
  tr.appendChild(td('col-vat', parentProduct.vatRate != null ? parentProduct.vatRate + '%' : '—'));

  // Origin (inherited from parent)
  const effectiveOrigin = (parentProduct.originCountry && parentProduct.originCountry.trim())
    ? parentProduct.originCountry.trim().toUpperCase()
    : countryToCode(state.artist.countryOfOrigin) || '—';
  tr.appendChild(td('col-origin', effectiveOrigin));

  // --- Sold columns ---
  const soldQtyCell = document.createElement('td');
  soldQtyCell.className = 'col-soldqty sold-col-start';
  soldQtyCell.style.textAlign = 'right';

  const soldValCell = document.createElement('td');
  soldValCell.className = 'col-soldval';
  soldValCell.style.textAlign = 'right';

  // Sold Qty (variant-specific, editable)
  const soldQtyInput = document.createElement('input');
  soldQtyInput.type = 'number';
  soldQtyInput.className = 'sold-input';
  soldQtyInput.min = '0';
  soldQtyInput.step = '1';
  soldQtyInput.value = variant.soldQty != null ? variant.soldQty : 0;
  soldQtyInput.addEventListener('change', () => {
    const varIdx = parentProduct.variants.findIndex(v => v.id === variant.id);
    if (varIdx >= 0) {
      parentProduct.variants[varIdx].soldQty = parseFloat(soldQtyInput.value) || 0;
      saveToStorage();
      renderTable();
      calcTotals();
    }
  });
  soldQtyCell.appendChild(soldQtyInput);

  // Sold Value (variant-specific, editable)
  const soldValInput = document.createElement('input');
  soldValInput.type = 'number';
  soldValInput.className = 'sold-input';
  soldValInput.min = '0';
  soldValInput.step = '0.01';
  soldValInput.value = variant.soldValue != null ? formatNum(variant.soldValue, 2) : '0.00';
  soldValInput.addEventListener('change', () => {
    const varIdx = parentProduct.variants.findIndex(v => v.id === variant.id);
    if (varIdx >= 0) {
      parentProduct.variants[varIdx].soldValue = parseFloat(soldValInput.value) || 0;
      saveToStorage();
      renderTable();
      calcTotals();
    }
  });
  soldValCell.appendChild(soldValInput);

  tr.appendChild(soldQtyCell);
  tr.appendChild(soldValCell);

  // Sold VAT (derived, read-only)
  const soldVatCell = document.createElement('td');
  soldVatCell.className = 'col-soldvat';
  soldVatCell.style.textAlign = 'right';
  soldVatCell.textContent = formatNum(floorN((variant.soldValue || 0) * ((parentProduct.vatRate || 0) / 100), 2), 2);
  tr.appendChild(soldVatCell);

  // Sold Weight (derived, read-only display)
  const soldWtCell = document.createElement('td');
  soldWtCell.className = 'col-soldweight';
  soldWtCell.style.textAlign = 'right';
  const soldWeightKg = (variant.soldQty || 0) * (varWg || 0) / 1000;
  soldWtCell.textContent = fmtWeightKg(soldWeightKg);
  tr.appendChild(soldWtCell);

  // Empty actions cell for variant (no edit/delete for variants from here)
  tr.appendChild(td('col-actions', ''));

  return tr;
}

function renderTotals() {
  const t = calcTotals();
  const cur = getCurrency();

  // ── Currency labels ──
  const colHdr = document.getElementById('col-header-totalval');
  if (colHdr) colHdr.textContent = `Total Value ${cur}`;
  const lblPrice = document.getElementById('label-m-price');
  if (lblPrice) lblPrice.textContent = `Price / item (${cur})`;
  const lblTotal = document.getElementById('label-m-totalvalue');
  if (lblTotal) lblTotal.textContent = `Total value (${cur})`;

  // ── All-products row ──
  document.getElementById('total-amount').textContent     = t.totalAmount.toLocaleString();
  document.getElementById('total-weight').textContent     = fmtWeightKg(t.totalWeightKg);
  document.getElementById('total-soldqty').textContent    = t.totalSoldQty.toLocaleString();
  document.getElementById('total-soldval').textContent    = cur + ' ' + Math.floor(t.totalSoldVal);
  document.getElementById('total-soldvat').textContent    = formatNum(t.totalSoldVat, 2);
  document.getElementById('total-soldweight').textContent = fmtWeightKg(t.totalSoldWeight);

  const totalValEl = document.getElementById('total-value');
  const rateKeys = Object.keys(t.byTariffRate).sort((a, b) => parseFloat(a) - parseFloat(b));
  if (rateKeys.length > 1) {
    const lines = rateKeys.map(r => {
      const rateLabel = r === '?' ? '?' : parseFloat(r).toFixed(1) + '%';
      return `<div class="total-by-rate">${rateLabel} · ${cur} ${Math.floor(t.byTariffRate[r].value)}</div>`;
    }).join('');
    totalValEl.innerHTML = `<div class="total-main">${cur} ${Math.floor(t.totalValue)}</div>${lines}`;
  } else {
    totalValEl.innerHTML = `<div class="total-main">${cur} ${Math.floor(t.totalValue)}</div>`;
  }

  // ── VAT estimates (customs-only) ──
  const vatEstEl = document.getElementById('vat-estimate-total');
  if (vatEstEl) vatEstEl.textContent = cur + ' ' + formatNum(t.customs.totalImportVat, 2);
  const vatEstSoldEl = document.getElementById('vat-estimate-sold');
  if (vatEstSoldEl) vatEstSoldEl.textContent = cur + ' ' + formatNum(t.customs.totalSoldVat, 2);

  // ── Customs-only row (show only when there are unlisted products) ──
  const customsRow = document.getElementById('totals-row-customs');
  if (customsRow) {
    customsRow.style.display = t.hasUnlisted ? '' : 'none';
    if (t.hasUnlisted) {
      const c = t.customs;
      document.getElementById('total-amount-customs').textContent     = c.totalAmount.toLocaleString();
      document.getElementById('total-weight-customs').textContent     = fmtWeightKg(c.totalWeightKg);
      document.getElementById('total-soldqty-customs').textContent    = c.totalSoldQty.toLocaleString();
      document.getElementById('total-soldval-customs').textContent    = cur + ' ' + Math.floor(c.totalSoldVal);
      document.getElementById('total-soldvat-customs').textContent    = formatNum(c.totalSoldVat, 2);
      document.getElementById('total-soldweight-customs').textContent = fmtWeightKg(c.totalSoldWeight);

      const custValEl = document.getElementById('total-value-customs');
      const custRateKeys = Object.keys(c.byTariffRate).sort((a, b) => parseFloat(a) - parseFloat(b));
      if (custRateKeys.length > 1) {
        const lines = custRateKeys.map(r => {
          const rateLabel = r === '?' ? '?' : parseFloat(r).toFixed(1) + '%';
          return `<div class="total-by-rate">${rateLabel} · ${cur} ${Math.floor(c.byTariffRate[r].value)}</div>`;
        }).join('');
        custValEl.innerHTML = `<div class="total-main">${cur} ${Math.floor(c.totalValue)}</div>${lines}`;
      } else {
        custValEl.innerHTML = `<div class="total-main">${cur} ${Math.floor(c.totalValue)}</div>`;
      }
    }
  }
}

function updateProductField(id, field, value) {
  const product = state.products.find(p => p.id === id);
  if (!product) return;
  product[field] = value;
  saveToStorage();
  renderTotals();
  updateSectionSummaries();
  // Re-render derived cells for this row
  const tr = document.querySelector(`tr[data-id="${id}"]`);
  if (tr) {
    const c = calcProduct(product);
    const soldWtCell = tr.querySelector('.col-soldweight');
    if (soldWtCell) soldWtCell.textContent = fmtWeightKg(c.soldWeightKg);
    const soldVatCell = tr.querySelector('.col-soldvat');
    if (soldVatCell) soldVatCell.textContent = formatNum(floorN((product.soldValue || 0) * ((product.vatRate || 0) / 100), 2), 2);
  }
}

/* =========================================================
   PRODUCT CRUD
   ========================================================= */
function deleteProduct(id) {
  const affectedDiscounts = (state.discounts || []).filter(d => (d.productIds || []).includes(id));
  let msg = 'Delete this product?';
  if (affectedDiscounts.length) {
    const names = affectedDiscounts.map(d => `"${d.name}"`).join(', ');
    msg += `\n\nWarning: this product is used in the following POS discount${affectedDiscounts.length > 1 ? 's' : ''}: ${names}.\nThe discount will still exist but this product will no longer be included.`;
  }
  if (!confirm(msg)) return;
  state.products = state.products.filter(p => p.id !== id);
  saveToStorage();
  renderTable();
}

function duplicateProduct(id) {
  const original = state.products.find(p => p.id === id);
  if (!original) return;
  const copy = Object.assign({}, original, { id: uuid(), soldQty: 0, soldValue: 0, soldVAT: 0 });
  const idx = state.products.findIndex(p => p.id === id);
  state.products.splice(idx + 1, 0, copy);
  saveToStorage();
  renderTable();
}

function addProduct(productData) {
  const product = Object.assign(
    {
      id:          uuid(),
      title:       '',
      sku:         '',
      forSale:     true,
      type:        '',
      amount:      0,
      weightG:     0,
      price:       null,
      priceNote:   '',
      totalValueCHF: null,
      tariffNo:      '',
      tariffRate:    null,
      vatRate:       null,
      packagingType: 'CT',
      soldQty:       0,
      soldValue:   0,
      soldVAT:     0,
    },
    productData
  );
  state.products.push(product);
  saveToStorage();
  renderTable();
}

function updateProduct(id, productData) {
  const idx = state.products.findIndex(p => p.id === id);
  if (idx === -1) return;
  state.products[idx] = Object.assign({}, state.products[idx], productData);
  saveToStorage();
  renderTable();
}

/* =========================================================
   MODAL
   ========================================================= */
let editingProductId = null;
let hsDropdownFocusIdx = -1;
let hsFilteredList = [];

function openAddModal() {
  editingProductId = null;
  document.getElementById('modal-title').textContent = 'Add Product';
  resetModalForm();
  showModal();
}

function openEditModal(id) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;
  editingProductId = id;
  document.getElementById('modal-title').textContent = 'Edit Product';
  populateModalForm(p);
  showModal();
}

function showModal() {
  document.getElementById('modal-overlay').style.display = 'flex';
  document.getElementById('m-title').focus();
  updateModalPreview();
}

function hideModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  closeHsDropdown();
  editingProductId = null;
}

function resetModalForm() {
  document.getElementById('m-title').value       = '';
  document.getElementById('m-sku').value         = '';
  document.getElementById('m-type').value        = '';
  document.getElementById('m-amount').value      = '';
  document.getElementById('m-weight').value      = '';
  document.getElementById('m-price').value       = '';
  document.getElementById('m-pricenote').value   = '';
  document.getElementById('m-hscode-input').value = '';
  document.getElementById('m-tariffrate').value  = '';
  document.getElementById('m-vatrate').value     = '';
  document.getElementById('m-origin').value      = '';
  document.getElementById('hs-desc-hint').textContent = '';
  document.getElementById('m-totalweight').value = '';
  document.getElementById('m-totalvalue').value  = '';
  document.getElementById('m-packaging').value   = 'CT';
  const vatHint = document.getElementById('vat-hint');
  if (vatHint) { vatHint.textContent = 'Standard rate'; vatHint.style.color = ''; }
  // Reset radio
  document.querySelector('input[name="m-forsale"][value="true"]').checked = true;
  // Reset unlisted
  document.getElementById('m-unlisted').checked = false;
  // Reset variants
  document.getElementById('m-has-variants').checked = false;
  document.getElementById('m-variants-body').style.display = 'none';
  document.getElementById('m-variant-rows').innerHTML = '';
  document.getElementById('m-amount-group').style.display = '';
  updateModalPreview();
}

function populateModalForm(p) {
  document.getElementById('m-title').value        = p.title        || '';
  document.getElementById('m-sku').value          = p.sku          || '';
  document.getElementById('m-type').value         = p.type         || '';
  document.getElementById('m-amount').value       = p.amount       != null ? p.amount  : '';
  document.getElementById('m-weight').value       = p.weightG      != null ? p.weightG : '';
  document.getElementById('m-price').value        = p.price        != null ? p.price   : '';
  document.getElementById('m-pricenote').value    = p.priceNote    || '';
  document.getElementById('m-hscode-input').value = p.tariffNo     || '';
  document.getElementById('m-tariffrate').value   = p.tariffRate   != null ? p.tariffRate : '';
  document.getElementById('m-vatrate').value      = p.vatRate      != null ? p.vatRate    : '';
  document.getElementById('m-origin').value       = p.originCountry || '';

  // Show HS description hint if code is known
  if (p.tariffNo) {
    const entry = HS_CODES.find(h => h.code === p.tariffNo);
    document.getElementById('hs-desc-hint').textContent = entry ? entry.desc : '';
  } else {
    document.getElementById('hs-desc-hint').textContent = '';
  }

  // Radio
  const forSaleVal = p.forSale ? 'true' : 'false';
  const radioEl = document.querySelector(`input[name="m-forsale"][value="${forSaleVal}"]`);
  if (radioEl) radioEl.checked = true;

  // Unlisted
  document.getElementById('m-unlisted').checked = !!p.unlisted;

  // Populate derived total weight
  if (p.weightG != null && p.amount != null && p.amount > 0) {
    document.getElementById('m-totalweight').value = parseFloat((p.weightG * p.amount / 1000).toFixed(4));
  } else {
    document.getElementById('m-totalweight').value = '';
  }
  // Populate derived total value
  const derivedTotal = p.totalValueCHF != null ? p.totalValueCHF
    : (p.price != null && p.amount != null ? p.price * p.amount : null);
  document.getElementById('m-totalvalue').value = derivedTotal != null ? parseFloat(derivedTotal).toFixed(2) : '';
  // Packaging
  document.getElementById('m-packaging').value = p.packagingType || 'CT';
  // VAT hint
  updateVatHint();

  // Variants
  const variantsEnabled = hasVariants(p);
  document.getElementById('m-has-variants').checked = variantsEnabled;
  document.getElementById('m-variants-body').style.display = variantsEnabled ? '' : 'none';
  document.getElementById('m-amount-group').style.display = variantsEnabled ? 'none' : '';
  document.getElementById('m-variant-rows').innerHTML = '';
  if (variantsEnabled) p.variants.forEach(v => addModalVariantRow(v));

  updateModalPreview();
}

function collectModalForm() {
  const title      = document.getElementById('m-title').value.trim();
  const sku        = document.getElementById('m-sku').value.trim();
  const type       = document.getElementById('m-type').value.trim();
  const forSale    = document.querySelector('input[name="m-forsale"]:checked').value === 'true';
  const unlisted   = document.getElementById('m-unlisted').checked;
  const amountStr  = document.getElementById('m-amount').value;
  const weightStr  = document.getElementById('m-weight').value;
  const priceStr   = document.getElementById('m-price').value;
  const priceNote  = document.getElementById('m-pricenote').value.trim();
  const tariffNo   = document.getElementById('m-hscode-input').value.trim();
  const tariffRate = document.getElementById('m-tariffrate').value;
  const vatRate    = document.getElementById('m-vatrate').value;
  const packagingType  = document.getElementById('m-packaging').value || 'CT';
  const originCountry  = document.getElementById('m-origin').value.trim().toUpperCase();

  const amount  = amountStr  !== '' ? parseFloat(amountStr)  : null;
  const weightG = weightStr  !== '' ? parseFloat(weightStr)  : null;
  const price   = priceStr   !== '' ? parseFloat(priceStr)   : null;

  // Read totalValueCHF directly from the total-value field to preserve what the user entered.
  // syncValueFromPerItem keeps this field in sync when the user edits per-item price,
  // so we never need to recompute price × amount here (which would lose precision on total/amount divisions).
  const totalValueStr = document.getElementById('m-totalvalue').value.trim();
  const totalValueCHF = totalValueStr !== '' ? parseFloat(totalValueStr) : null;

  const variantsEnabled = document.getElementById('m-has-variants').checked;
  let variants = [];
  if (variantsEnabled) {
    variants = [...document.querySelectorAll('#m-variant-rows .variant-edit-row')].map(row => ({
      id:        row.dataset.vid || uuid(),
      name:      row.querySelector('.vr-name').value.trim(),
      sku:       row.querySelector('.vr-sku').value.trim(),
      amount:    parseInt(row.querySelector('.vr-amount').value) || 0,
      price:     row.querySelector('.vr-price').value  !== '' ? parseFloat(row.querySelector('.vr-price').value)  : null,
      weightG:   row.querySelector('.vr-weight').value !== '' ? parseFloat(row.querySelector('.vr-weight').value) : null,
      unlisted:  row.querySelector('.vr-unlisted').checked || false,
      soldQty:   parseFloat(row.dataset.soldqty)  || 0,
      soldValue: parseFloat(row.dataset.soldval)  || 0,
    }));
  }

  return {
    title,
    sku,
    type,
    forSale,
    unlisted,
    amount:        variantsEnabled ? 0 : (amount  != null ? amount  : 0),
    weightG:       weightG != null ? weightG : 0,
    price,
    priceNote,
    totalValueCHF: variantsEnabled ? null : totalValueCHF,
    tariffNo,
    tariffRate:    tariffRate !== '' ? parseFloat(tariffRate) : null,
    vatRate:       vatRate    !== '' ? parseFloat(vatRate)    : null,
    packagingType,
    originCountry,
    variants,
  };
}

function validateModalForm() {
  const title  = document.getElementById('m-title').value.trim();
  if (!title) {
    showToast('Please enter a product title.', 'error');
    document.getElementById('m-title').focus();
    return false;
  }
  const variantsEnabled = document.getElementById('m-has-variants').checked;
  if (!variantsEnabled) {
    const amount = document.getElementById('m-amount').value;
    if (amount === '' || isNaN(parseFloat(amount))) {
      showToast('Please enter a valid amount.', 'error');
      document.getElementById('m-amount').focus();
      return false;
    }
  } else {
    const rows = document.querySelectorAll('#m-variant-rows .variant-edit-row');
    if (!rows.length) {
      showToast('Add at least one variant, or disable variants.', 'error');
      return false;
    }
    for (const row of rows) {
      if (!row.querySelector('.vr-name').value.trim()) {
        showToast('Each variant needs a name.', 'error');
        row.querySelector('.vr-name').focus();
        return false;
      }
    }
  }
  return true;
}

function addModalVariantRow(v = null) {
  const container = document.getElementById('m-variant-rows');
  const row = document.createElement('div');
  row.className = 'variant-edit-row';
  row.dataset.vid      = v ? (v.id || uuid()) : uuid();
  row.dataset.soldqty  = v ? (v.soldQty  || 0) : 0;
  row.dataset.soldval  = v ? (v.soldValue || 0) : 0;
  row.innerHTML = `
    <input type="text"   class="vr-name"   placeholder="Name *" />
    <input type="text"   class="vr-sku"    placeholder="SKU (optional)" />
    <input type="number" class="vr-amount" placeholder="Amount *" min="0" step="1" />
    <input type="number" class="vr-price"  placeholder="Inherit" min="0" step="0.01" />
    <input type="number" class="vr-weight" placeholder="Inherit" min="0" step="1" />
    <label class="vr-unlisted-label" title="Exclude this variant from customs documents">
      <input type="checkbox" class="vr-unlisted" />
      Unlisted
    </label>
    <button type="button" class="vr-remove">✕</button>
  `;
  if (v) {
    row.querySelector('.vr-name').value   = v.name   || '';
    row.querySelector('.vr-sku').value    = v.sku    || '';
    row.querySelector('.vr-amount').value = v.amount != null ? v.amount : '';
    if (v.price    != null) row.querySelector('.vr-price').value  = v.price;
    if (v.weightG  != null) row.querySelector('.vr-weight').value = v.weightG;
    if (v.unlisted)         row.querySelector('.vr-unlisted').checked = true;
  }
  row.querySelector('.vr-remove').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

// Wire up variant toggle and add-variant button (runs once after DOM ready)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('m-has-variants').addEventListener('change', e => {
    const on = e.target.checked;
    document.getElementById('m-variants-body').style.display = on ? '' : 'none';
    document.getElementById('m-amount-group').style.display  = on ? 'none' : '';
    if (on && !document.querySelector('#m-variant-rows .variant-edit-row')) {
      addModalVariantRow(); // start with one empty row
    }
  });
  document.getElementById('m-add-variant').addEventListener('click', () => addModalVariantRow());
});

function saveModal() {
  if (!validateModalForm()) return;
  const data = collectModalForm();
  if (editingProductId) {
    updateProduct(editingProductId, data);
  } else {
    addProduct(data);
  }
  hideModal();
  showToast(editingProductId ? 'Product updated.' : 'Product added.', 'success');
}

/* =========================================================
   BIDIRECTIONAL WEIGHT / VALUE SYNC
   ========================================================= */
let _syncLock = false;

function syncWeightFromPerItem() {
  if (_syncLock) return;
  const amount = parseFloat(document.getElementById('m-amount').value) || 0;
  const wg     = parseFloat(document.getElementById('m-weight').value);
  if (!isNaN(wg) && amount > 0) {
    _syncLock = true;
    document.getElementById('m-totalweight').value = parseFloat((wg * amount / 1000).toFixed(4));
    _syncLock = false;
  }
}

function syncWeightFromTotal() {
  if (_syncLock) return;
  const amount = parseFloat(document.getElementById('m-amount').value) || 0;
  const twkg   = parseFloat(document.getElementById('m-totalweight').value);
  if (!isNaN(twkg) && amount > 0) {
    _syncLock = true;
    document.getElementById('m-weight').value = parseFloat((twkg * 1000 / amount).toFixed(2));
    _syncLock = false;
  }
}

function syncValueFromPerItem() {
  if (_syncLock) return;
  const amount = parseFloat(document.getElementById('m-amount').value) || 0;
  const price  = parseFloat(document.getElementById('m-price').value);
  if (!isNaN(price) && amount > 0) {
    _syncLock = true;
    document.getElementById('m-totalvalue').value = parseFloat((price * amount).toFixed(2));
    _syncLock = false;
  }
}

function syncValueFromTotal() {
  if (_syncLock) return;
  const amount = parseFloat(document.getElementById('m-amount').value) || 0;
  const total  = parseFloat(document.getElementById('m-totalvalue').value);
  if (!isNaN(total) && amount > 0) {
    _syncLock = true;
    document.getElementById('m-price').value = parseFloat((total / amount).toFixed(4));
    _syncLock = false;
  }
}

function updateModalPreview() {
  const amount    = parseFloat(document.getElementById('m-amount').value)  || 0;
  const weightG   = parseFloat(document.getElementById('m-weight').value);
  const price     = parseFloat(document.getElementById('m-price').value);
  const priceNote = document.getElementById('m-pricenote').value.trim();

  const totalWeightKg = (!isNaN(weightG) && amount > 0) ? (amount * weightG) / 1000 : null;
  const weightEl = document.getElementById('preview-weight');
  const valueEl  = document.getElementById('preview-value');

  weightEl.textContent = (totalWeightKg != null && totalWeightKg > 0)
    ? fmtWeightKg(totalWeightKg) : '— kg';

  if (!isNaN(price) && price >= 0 && amount > 0) {
    valueEl.textContent = fmtCHF(price * amount);
  } else if (priceNote) {
    valueEl.textContent = priceNote;
  } else {
    valueEl.textContent = 'CHF —';
  }
}

/* =========================================================
   HS CODE COMBOBOX
   ========================================================= */
function initHsCombobox() {
  const input    = document.getElementById('m-hscode-input');
  const dropdown = document.getElementById('hs-dropdown');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      closeHsDropdown();
      document.getElementById('hs-desc-hint').textContent = '';
      return;
    }

    hsFilteredList = HS_CODES.filter(h =>
      h.code.toLowerCase().includes(q) ||
      h.desc.toLowerCase().includes(q)
    );

    if (hsFilteredList.length === 0) {
      closeHsDropdown();
      document.getElementById('hs-desc-hint').textContent = '';
      return;
    }

    renderHsDropdown(hsFilteredList);
    dropdown.style.display = 'block';
    hsDropdownFocusIdx = -1;
  });

  input.addEventListener('keydown', (e) => {
    const items = dropdown.querySelectorAll('.hs-option');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      hsDropdownFocusIdx = Math.min(hsDropdownFocusIdx + 1, items.length - 1);
      updateHsFocus(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      hsDropdownFocusIdx = Math.max(hsDropdownFocusIdx - 1, 0);
      updateHsFocus(items);
    } else if (e.key === 'Enter' && hsDropdownFocusIdx >= 0) {
      e.preventDefault();
      selectHsCode(hsFilteredList[hsDropdownFocusIdx]);
    } else if (e.key === 'Escape') {
      closeHsDropdown();
    }
  });

  input.addEventListener('blur', (e) => {
    // Delay to allow click on dropdown item
    setTimeout(() => {
      if (!dropdown.contains(document.activeElement)) {
        closeHsDropdown();
      }
    }, 150);
  });
}

/* =========================================================
   COUNTRY PICKER
   ========================================================= */
function initCountryPicker(inputEl, opts = {}) {
  const showName = !!opts.showName; // if true, display full country name instead of code

  // Wrap in a relative-positioned container
  const wrapper = document.createElement('div');
  wrapper.className = 'country-picker';
  inputEl.parentNode.insertBefore(wrapper, inputEl);
  wrapper.appendChild(inputEl);

  const dropdown = document.createElement('div');
  dropdown.className = 'country-dropdown';
  dropdown.style.display = 'none';
  wrapper.appendChild(dropdown);

  function renderDropdown(query) {
    const q = query.trim().toLowerCase();
    const matches = q
      ? COUNTRIES.filter(c =>
          c.code.toLowerCase().startsWith(q) ||
          c.name.toLowerCase().includes(q)
        )
      : COUNTRIES;

    dropdown.innerHTML = '';
    matches.slice(0, 80).forEach(c => {
      const item = document.createElement('div');
      item.className = 'country-item';
      item.innerHTML = `<span class="cp-code">${c.code}</span><span class="cp-name">${c.name}</span>`;
      item.addEventListener('mousedown', e => {
        e.preventDefault(); // keep focus on input
        inputEl.value = showName ? c.name : c.code;
        inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        dropdown.style.display = 'none';
      });
      dropdown.appendChild(item);
    });

    dropdown.style.display = matches.length ? 'block' : 'none';
  }

  inputEl.addEventListener('focus', () => renderDropdown(inputEl.value));
  inputEl.addEventListener('input', () => renderDropdown(inputEl.value));
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { dropdown.style.display = 'none'; inputEl.blur(); }
  });
  inputEl.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none'; }, 160);
    const val = inputEl.value.trim();
    const code = COUNTRY_BY_CODE[val.toUpperCase()] ? val.toUpperCase() : null;
    const byName = COUNTRIES.find(c => c.name.toLowerCase() === val.toLowerCase());
    if (showName) {
      // Normalise to full name
      if (code) {
        // user typed a code like "DE" -expand to name
        inputEl.value = COUNTRY_BY_CODE[code];
        inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (byName) {
        inputEl.value = byName.name;
        inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      // Normalise to uppercase code
      if (code) {
        inputEl.value = code;
        inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (byName) {
        inputEl.value = byName.code;
        inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });
}

function renderHsDropdown(list) {
  const dropdown = document.getElementById('hs-dropdown');
  dropdown.innerHTML = '';
  list.forEach((h, i) => {
    const opt = document.createElement('div');
    opt.className = 'hs-option';
    opt.dataset.idx = i;

    const codeSpan = document.createElement('span');
    codeSpan.className = 'hs-code';
    codeSpan.textContent = h.code;

    const descSpan = document.createElement('span');
    descSpan.className = 'hs-desc';
    descSpan.textContent = h.desc;

    const rateSpan = document.createElement('span');
    rateSpan.className = 'hs-rate';
    rateSpan.textContent = h.rate + '%';

    opt.appendChild(codeSpan);
    opt.appendChild(descSpan);
    opt.appendChild(rateSpan);

    opt.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur
      selectHsCode(h);
    });

    dropdown.appendChild(opt);
  });
}

function updateHsFocus(items) {
  items.forEach((item, i) => {
    item.classList.toggle('focused', i === hsDropdownFocusIdx);
  });
  if (hsDropdownFocusIdx >= 0 && items[hsDropdownFocusIdx]) {
    items[hsDropdownFocusIdx].scrollIntoView({ block: 'nearest' });
  }
}

function updateVatHint() {
  const vatVal = parseFloat(document.getElementById('m-vatrate').value);
  const hint = document.getElementById('vat-hint');
  if (!hint) return;
  if (vatVal <= 2.6) {
    hint.textContent = 'Reduced rate (printed books/brochures)';
    hint.style.color = '#1a7a3e';
  } else {
    hint.textContent = 'Standard rate';
    hint.style.color = '';
  }
}

function selectHsCode(h) {
  document.getElementById('m-hscode-input').value = h.code;
  document.getElementById('m-tariffrate').value   = h.rate;
  document.getElementById('m-vatrate').value       = h.vatRate != null ? h.vatRate : 8.1;
  document.getElementById('hs-desc-hint').textContent = h.desc;
  updateVatHint();
  closeHsDropdown();
  updateModalPreview();
}

function closeHsDropdown() {
  const dropdown = document.getElementById('hs-dropdown');
  if (dropdown) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
  }
  hsDropdownFocusIdx = -1;
  hsFilteredList = [];
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const combobox = document.getElementById('hs-combobox');
  if (combobox && !combobox.contains(e.target)) {
    closeHsDropdown();
  }
});

/* =========================================================
   SAVE / LOAD JSON
   ========================================================= */
function saveJSON() {
  const filename = buildFilename();
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
  showToast('JSON saved: ' + filename, 'success');
}

function buildFilename() {
  const event  = state.meta.event  || 'ZollTool';
  const artist = state.artist.companyName || state.artist.fullName || '';
  const date   = new Date().toISOString().slice(0, 10);
  const parts  = [event, artist, date].filter(Boolean).join('_');
  return parts.replace(/[^a-zA-Z0-9_\-\.]/g, '_') + '.json';
}

function loadJSON() {
  document.getElementById('file-input').click();
}

function handleFileLoad(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const parsed = JSON.parse(evt.target.result);
      state = {
        meta:         Object.assign({}, DEFAULT_STATE.meta,     parsed.meta     || {}),
        artist:       Object.assign({}, DEFAULT_STATE.artist,   parsed.artist   || {}),
        edec:         Object.assign({}, DEFAULT_STATE.edec,     parsed.edec     || {}),
        products:     Array.isArray(parsed.products)     ? parsed.products     : [],
        form1174:     Object.assign({}, DEFAULT_STATE.form1174, parsed.form1174 || {}),
        discounts:    Array.isArray(parsed.discounts)    ? parsed.discounts    : [],
        transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      };
      if (!Array.isArray(state.form1174.assignments)) state.form1174.assignments = [];
      if (!state.meta.venueTIN) state.meta.venueTIN = DEFAULT_STATE.meta.venueTIN;
      saveToStorage();
      syncFormFields();
      updateSectionSummaries();
    
      renderTable();
      showToast('Loaded: ' + file.name, 'success');
    } catch (err) {
      showToast('Invalid JSON file.', 'error');
      console.error(err);
    }
    // Reset so same file can be loaded again
    e.target.value = '';
  };
  reader.readAsText(file);
}

// Sync form inputs to state (after load)
function syncFormFields() {
  $$('[data-key]').forEach(input => {
    const key = input.dataset.key;
    const [section, field] = key.split('.');
    if (state[section] && state[section][field] != null) {
      input.value = state[section][field];
    } else {
      input.value = '';
    }
  });
  // Sync flatpickr instances (second arg false = no onChange callback)
  if (fpStart) fpStart.setDate(state.meta.eventDateStart || null, false);
  if (fpEnd)   fpEnd.setDate(state.meta.eventDateEnd   || null, false);

  // Sync doc-number select
  const docNumEl = document.getElementById('doc-number');
  if (docNumEl && state.meta.documentNumber) docNumEl.value = String(state.meta.documentNumber);
  autoGenerateLRP();
}

/* =========================================================
   LRP CODE GENERATION
   ========================================================= */
function parseDateFromEventDates(str) {
  if (!str) return null;
  // "14. – 16.05.2026" → month=5, year=2026
  let m = str.match(/(\d{2})\.(20\d{2})/);
  if (m) return { month: parseInt(m[1], 10), year: parseInt(m[2], 10) };
  // "14-16 May 2026" or "14–16 May 2026"
  const monthNames = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  m = str.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*(20\d{2})/i);
  if (m) return { month: monthNames[m[1].toLowerCase().slice(0,3)], year: parseInt(m[2], 10) };
  // "2026-05" or just year
  m = str.match(/\b(20\d{2})-(\d{2})\b/);
  if (m) return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
  m = str.match(/\b(20\d{2})\b/);
  if (m) return { year: parseInt(m[1], 10), month: null };
  return null;
}

function computeLRP(docNum) {
  const originCC = countryToCode(state.artist.countryOfOrigin) || 'XX';
  const code     = (state.meta.companyCode || '').toUpperCase() || 'XX';
  const now      = new Date();
  let year  = now.getFullYear();
  let month = now.getMonth() + 1;
  if (state.meta.eventDateStart) {
    const d = new Date(state.meta.eventDateStart + 'T00:00:00');
    year  = d.getFullYear();
    month = d.getMonth() + 1;
  }
  const mm  = String(month).padStart(2, '0');
  const nnn = String(docNum).padStart(3, '0');
  return `${originCC}CH_${code}_${year}_${mm}_${nnn}`;
}

function autoGenerateLRP() {
  const docEl  = document.getElementById('doc-number');
  const docNum = docEl ? (parseInt(docEl.value, 10) || 1) : (state.meta.documentNumber || 1);
  const lrp    = computeLRP(docNum);
  const lrpEl  = document.getElementById('event-lrp');
  if (lrpEl) lrpEl.value = lrp;
  state.meta.lrp = lrp;
  state.meta.documentNumber = docNum;
  saveToStorage();
  updateSectionSummaries();
}

/* =========================================================
   PRINT / PDF EXPORT -AUXILIARY DOCUMENT
   ========================================================= */

function showDocumentFormatDialog(docNum) {
  const docNames = { 1: 'Import', 2: 'Sold Goods', 3: 'Return Goods' };
  const docName = docNames[docNum] || 'Document';

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const bgColor   = isDark ? '#1f2937' : '#ffffff';
  const textColor = isDark ? '#f9fafb' : '#111827';
  const subColor  = isDark ? '#9ca3af' : '#6b7280';

  const dialogHtml = `
    <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 10000;">
      <div style="background: ${bgColor}; color: ${textColor}; border-radius: 10px; padding: 24px; max-width: 500px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
          <h3 style="margin: 0; font-size: 17px; font-weight: bold;">${esc(docName)} Document Format</h3>
          <button id="format-close" style="background: none; border: none; cursor: pointer; color: ${subColor}; font-size: 20px; line-height: 1; padding: 0 2px;" title="Close">&times;</button>
        </div>
        <p style="margin: 0 0 16px 0; font-size: 13px; color: ${subColor};">Choose how to format the document:</p>
        <div style="display: flex; gap: 10px; margin-bottom: 12px;">
          <button id="format-detailed" style="flex: 1; padding: 11px 8px; background: #3b5bdb; color: white; border: none; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; line-height: 1.4;">
            Detailed<br><span style="font-size: 11px; opacity: 0.85;">One row per variant</span>
          </button>
          <button id="format-compressed" style="flex: 1; padding: 11px 8px; background: #555; color: white; border: none; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; line-height: 1.4;">
            Compressed<br><span style="font-size: 11px; opacity: 0.85;">One row per product</span>
          </button>
          <button id="format-bytype" style="flex: 1; padding: 11px 8px; background: #0a7c4e; color: white; border: none; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; line-height: 1.4;">
            By Type<br><span style="font-size: 11px; opacity: 0.85;">Totals per category</span>
          </button>
        </div>
        <div style="border-top: 1px solid ${isDark ? '#374151' : '#e5e7eb'}; padding-top: 12px;">
          <button id="format-printall" style="width: 100%; padding: 10px; background: none; border: 1px solid ${isDark ? '#4b5563' : '#d1d5db'}; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; color: ${textColor}; display: flex; align-items: center; justify-content: center; gap: 8px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            Print All Formats (Detailed + Compressed + By Type)
          </button>
        </div>
      </div>
    </div>
  `;

  const overlay = document.createElement('div');
  overlay.innerHTML = dialogHtml;
  document.body.appendChild(overlay);

  overlay.querySelector('#format-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#format-detailed').addEventListener('click', () => { overlay.remove(); printGoodsList(docNum, 'detailed'); });
  overlay.querySelector('#format-compressed').addEventListener('click', () => { overlay.remove(); printGoodsList(docNum, 'compressed'); });
  overlay.querySelector('#format-bytype').addEventListener('click', () => { overlay.remove(); printGoodsList(docNum, 'bytype'); });
  overlay.querySelector('#format-printall').addEventListener('click', () => { overlay.remove(); printAllVersions(docNum); });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

/* =========================================================
   FORMAT DIALOG — TEMPORARY ADMISSION FORMS (11.74 / 11.87)
   The form itself is fixed-format, so the dialog controls the
   goods-list attachment that is printed alongside the form.
   ========================================================= */
function showFormFormatDialog(formLabel, formPrintFn, attachDocNum) {
  // attachDocNum: 1 = Import (for 11.74), 3 = Return/Re-export (for 11.87)
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const bgColor   = isDark ? '#1f2937' : '#ffffff';
  const textColor = isDark ? '#f9fafb' : '#111827';
  const subColor  = isDark ? '#9ca3af' : '#6b7280';

  const dialogHtml = `
    <div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10000;">
      <div style="background:${bgColor};color:${textColor};border-radius:10px;padding:24px;max-width:520px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <h3 style="margin:0;font-size:17px;font-weight:bold;">${esc(formLabel)}</h3>
          <button id="ffd-close" style="background:none;border:none;cursor:pointer;color:${subColor};font-size:20px;line-height:1;padding:0 2px;" title="Close">&times;</button>
        </div>
        <p style="margin:0 0 4px 0;font-size:13px;color:${subColor};">The form prints in its standard fixed format.</p>
        <p style="margin:0 0 16px 0;font-size:13px;color:${subColor};">Choose the format for the <strong style="color:${textColor}">goods list attachment</strong> that prints alongside it:</p>
        <div style="display:flex;gap:10px;margin-bottom:12px;">
          <button id="ffd-detailed" style="flex:1;padding:11px 8px;background:#3b5bdb;color:white;border:none;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;line-height:1.4;">
            Detailed<br><span style="font-size:11px;opacity:0.85;">One row per variant</span>
          </button>
          <button id="ffd-compressed" style="flex:1;padding:11px 8px;background:#555;color:white;border:none;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;line-height:1.4;">
            Compressed<br><span style="font-size:11px;opacity:0.85;">One row per product</span>
          </button>
          <button id="ffd-bytype" style="flex:1;padding:11px 8px;background:#0a7c4e;color:white;border:none;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;line-height:1.4;">
            By Type<br><span style="font-size:11px;opacity:0.85;">Totals per category</span>
          </button>
        </div>
        <div style="border-top:1px solid ${isDark ? '#374151' : '#e5e7eb'};padding-top:12px;">
          <button id="ffd-printall" style="width:100%;padding:10px;background:none;border:1px solid ${isDark ? '#4b5563' : '#d1d5db'};border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;color:${textColor};display:flex;align-items:center;justify-content:center;gap:8px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            Print All Attachment Formats (Detailed + Compressed + By Type)
          </button>
        </div>
      </div>
    </div>
  `;

  const overlay = document.createElement('div');
  overlay.innerHTML = dialogHtml;
  document.body.appendChild(overlay);

  const remove = () => overlay.remove();

  overlay.querySelector('#ffd-close').addEventListener('click', remove);
  overlay.addEventListener('click', e => { if (e.target === overlay.firstElementChild) remove(); });

  overlay.querySelector('#ffd-detailed').addEventListener('click', () => {
    remove(); formPrintFn(); printGoodsList(attachDocNum, 'detailed');
  });
  overlay.querySelector('#ffd-compressed').addEventListener('click', () => {
    remove(); formPrintFn(); printGoodsList(attachDocNum, 'compressed');
  });
  overlay.querySelector('#ffd-bytype').addEventListener('click', () => {
    remove(); formPrintFn(); printGoodsList(attachDocNum, 'bytype');
  });
  overlay.querySelector('#ffd-printall').addEventListener('click', () => {
    remove(); formPrintFn(); printAllVersions(attachDocNum);
  });
}

/* =========================================================
   PRINT ALL VERSIONS
   ========================================================= */
function printAllVersions(onlyDocNum = null) {
  const m   = state.meta;
  const a   = state.artist;
  const cur = getCurrency();
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const hasCustomsInfo = p => !p.unlisted && (!!(p.tariffNo && p.tariffNo.trim()) || (p.vatRate != null && p.vatRate !== ''));

  // Helper: generate the full goods-list HTML body for a given docNum + format (no window open)
  function buildGoodsListBody(docNum, format) {
    const lrp = computeLRP(docNum);
    const docTitles = {
      1: 'Auxiliary Document for the Customs Declaration - Import',
      2: 'Auxiliary Document for the Customs Declaration - Sold Goods',
      3: 'Return Goods List - Re-export Declaration',
    };

    const header = `<div class="doc-top">
  <div class="doc-top-left">
    <div class="doc-title">${esc(docTitles[docNum] || docTitles[1])}</div>
    <div class="doc-subtitle">${esc(fmtEventDates(m.eventDateStart, m.eventDateEnd))}${m.eventLocation ? ', ' + esc(m.eventLocation) : ''}</div>
  </div>
  <div class="doc-top-right">
    <div class="event-name">${esc(m.event || '')}</div>
    <div class="lrp">LRP: ${esc(lrp || '—')}</div>
  </div>
</div>
<table class="info-table">
  <tr><td class="lbl">Artist / Company Name</td><td>${esc(a.companyName || '')}</td>
      <td class="lbl">Name &amp; Surname</td><td>${esc(a.fullName || '')}</td></tr>
  <tr><td class="lbl">Street &amp; House Number</td><td>${esc(a.street || '')}</td>
      <td class="lbl">Postcode &amp; City</td><td>${esc(a.postCodeCity || '')}</td></tr>
  <tr><td class="lbl">Country of Origin</td><td>${esc(a.countryOfOrigin || '')}</td>
      <td class="lbl">Phone / Mobile</td><td>${esc(a.phone || '')}</td></tr>
  <tr><td class="lbl">Email</td><td colspan="3">${esc(a.email || '')}</td></tr>
</table>`;

    // Open a temp hidden window, generate the table, extract inner HTML
    // Instead, we'll call a lightweight version of printGoodsList that returns HTML
    return `<div class="doc-section">${header}${buildGoodsTable(docNum, format)}<div class="signature-section"><strong>Date and Signature</strong><div class="signature-box"></div></div></div>`;
  }

  function buildGoodsTable(docNum, format) {
    let tableHtml = '';
    const lrp = computeLRP(docNum);

    // ── IMPORT ──
    if (docNum === 1) {
      let totAmt=0, totWkg=0, totVal=0, rowNum=0;
      let rows = [];
      if (format === 'bytype') {
        const groups = {};
        state.products.filter(hasCustomsInfo).forEach(p => {
          const c = calcProduct(p);
          const key = `${p.type||'Other'}\x00${p.tariffNo||''}`;
          if (!groups[key]) groups[key] = { type:p.type||'Other', tariffNo:p.tariffNo||'', tariffRate:p.tariffRate, vatRate:p.vatRate, amount:0, wkg:0, val:0, hasVal:false };
          const g = groups[key];
          g.amount+=(c.amount||0); g.wkg+=c.totalWeightKg;
          if(c.totalValue!=null){g.val+=c.totalValue; g.hasVal=true;}
          totAmt+=(c.amount||0); totWkg+=c.totalWeightKg;
          if(c.totalValue!=null) totVal+=c.totalValue;
        });
        Object.values(groups).forEach((g,i)=>{
          rows.push(`<tr><td class="c">${i+1}</td><td><strong>${esc(g.type)}</strong></td><td class="r">${esc(g.tariffNo)}</td><td class="r">${g.tariffRate!=null?g.tariffRate+'%':''}</td><td class="r">${g.vatRate!=null?g.vatRate+'%':''}</td><td class="r">${g.amount}</td><td class="r">${fmtWeightKg(g.wkg)}</td><td class="r">${g.hasVal?g.val:'—'}</td></tr>`);
        });
        tableHtml = `<div class="section-title">List of goods (By Type)</div>
<table class="goods"><thead><tr><th>#</th><th>Type</th><th class="r">HS Code</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="r">Total Amount</th><th class="r">Total Weight</th><th class="r">Total Value (${cur})</th></tr></thead>
<tbody>${rows.join('')}</tbody><tfoot><tr><td colspan="5" style="text-align:right">TOTALS</td><td class="r">${totAmt}</td><td class="r">${fmtWeightKg(totWkg)}</td><td class="r" style="color:#c00">${Math.floor(totVal)}</td></tr></tfoot></table>`;
      } else {
        state.products.filter(hasCustomsInfo).forEach(p => {
          const c = calcProduct(p);
          const pOrig = (p.originCountry&&p.originCountry.trim())?p.originCountry.trim().toUpperCase():(countryToCode(a.countryOfOrigin)||'');
          if (format==='detailed' && hasVariants(p)) {
            p.variants.forEach(v => {
              const i=rowNum++; const varWg=v.weightG!=null?v.weightG:p.weightG; const varPrice=v.price!=null?v.price:p.price;
              const varAmt=v.amount||0; const varTWkg=Math.round(varAmt*(varWg||0))/1000; const varTV=varPrice!=null?Math.round(varPrice*varAmt):null;
              totAmt+=varAmt; totWkg+=varTWkg; if(varTV!=null)totVal+=varTV;
              rows.push(`<tr><td class="c">${i+1}</td><td>${esc(v.sku||p.sku||'')}</td><td>${esc(p.title||'')} - ${esc(v.name||'')}</td><td>${p.forSale?'For Sale':'Not For Sale'}</td><td>${esc(p.type||'')}</td><td class="r">${varAmt}</td><td class="r">${varWg!=null?varWg+' g':''}</td><td class="r">${fmtWeightKg(varTWkg)}</td><td class="r">${p.priceNote||(varPrice!=null?formatNum(floorN(varPrice,2),2):'—')}</td><td class="r">${varTV!=null?varTV:'—'}</td><td class="r">${esc(p.tariffNo||'')}</td><td class="r">${p.tariffRate!=null?p.tariffRate+'%':''}</td><td class="r">${p.vatRate!=null?p.vatRate+'%':''}</td><td class="c">${esc(pOrig)}</td></tr>`);
            });
          } else {
            const i=rowNum++; totAmt+=(c.amount||0); totWkg+=c.totalWeightKg; if(c.totalValue!=null)totVal+=c.totalValue;
            const td=hasVariants(p)?`${esc(p.title||'')} (${p.variants.length} variants)`:`${esc(p.title||'')}`;
            rows.push(`<tr><td class="c">${i+1}</td><td>${esc(p.sku||'')}</td><td>${td}</td><td>${p.forSale?'For Sale':'Not For Sale'}</td><td>${esc(p.type||'')}</td><td class="r">${c.amount??''}</td><td class="r">${c.effectiveUnitWeightG!=null?Math.round(c.effectiveUnitWeightG)+' g':''}</td><td class="r">${fmtWeightKg(c.totalWeightKg)}</td><td class="r">${p.priceNote||(c.effectiveUnitPrice!=null?formatNum(floorN(c.effectiveUnitPrice,2),2):'—')}</td><td class="r">${c.totalValue!=null?c.totalValue:'—'}</td><td class="r">${esc(p.tariffNo||'')}</td><td class="r">${p.tariffRate!=null?p.tariffRate+'%':''}</td><td class="r">${p.vatRate!=null?p.vatRate+'%':''}</td><td class="c">${esc(pOrig)}</td></tr>`);
          }
        });
        const fl = format==='detailed'?' (Detailed)':' (Compressed)';
        tableHtml = `<div class="section-title">List of goods${fl}</div>
<table class="goods"><thead><tr><th>#</th><th>SKU</th><th>Title</th><th>For Sale / Not For Sale</th><th>Type</th><th class="r">Amount</th><th class="r">Unit Weight</th><th class="r">Total Weight</th><th class="r">Unit Price (${cur})</th><th class="r">Total Value (${cur})</th><th class="r">Tariff no.</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="c">Origin</th></tr></thead>
<tbody>${rows.join('')}</tbody><tfoot><tr><td colspan="5" style="text-align:right">TOTALS</td><td class="r">${totAmt}</td><td></td><td class="r">${fmtWeightKg(totWkg)}</td><td></td><td class="r" style="color:#c00">${Math.floor(totVal)}</td><td colspan="4"></td></tr></tfoot></table>`;
      }

    // ── SOLD ──
    } else if (docNum === 2) {
      let totSQ=0,totSV=0,totSWkg=0,rowNum=0;
      let rows=[];
      if (format==='bytype') {
        const groups={};
        state.products.forEach(p=>{
          if(!hasCustomsInfo(p))return; const c=calcProduct(p); if(!(c.soldQty>0))return;
          const key=`${p.type||'Other'}\x00${p.tariffNo||''}`;
          if(!groups[key])groups[key]={type:p.type||'Other',tariffNo:p.tariffNo||'',tariffRate:p.tariffRate,vatRate:p.vatRate,soldQty:0,soldVal:0,soldWkg:0};
          const g=groups[key];
          g.soldQty+=(c.soldQty||0); g.soldVal+=floorN(c.soldValue||0,2); g.soldWkg+=c.soldWeightKg;
          totSQ+=(c.soldQty||0); totSV+=floorN(c.soldValue||0,2); totSWkg+=c.soldWeightKg;
        });
        Object.values(groups).forEach((g,i)=>{
          rows.push(`<tr><td class="c">${i+1}</td><td><strong>${esc(g.type)}</strong></td><td class="r">${esc(g.tariffNo)}</td><td class="r">${g.tariffRate!=null?g.tariffRate+'%':''}</td><td class="r">${g.vatRate!=null?g.vatRate+'%':''}</td><td class="r">${g.soldQty}</td><td class="r">${formatNum(floorN(g.soldVal,2),2)}</td><td class="r">${fmtWeightKg(g.soldWkg)}</td></tr>`);
        });
        tableHtml=`<div class="section-title">List of goods sold (By Type)</div>
<table class="goods"><thead><tr><th>#</th><th>Type</th><th class="r">HS Code</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="r">Qty Sold</th><th class="r">Value Sold (${cur})</th><th class="r">Sold Weight</th></tr></thead>
<tbody>${rows.join('')||'<tr><td colspan="8" style="text-align:center;color:#888;padding:8px">No sold quantities entered</td></tr>'}</tbody>
<tfoot><tr><td colspan="5" style="text-align:right">TOTALS</td><td class="r">${totSQ}</td><td class="r">${formatNum(floorN(totSV,2),2)}</td><td class="r">${fmtWeightKg(totSWkg)}</td></tr></tfoot></table>`;
      } else {
        state.products.forEach(p=>{
          if(!hasCustomsInfo(p))return; const c=calcProduct(p);
          if(format==='detailed'&&hasVariants(p)){
            p.variants.forEach(v=>{
              if(!(v.soldQty>0))return; rowNum++;
              const varWg=v.weightG!=null?v.weightG:p.weightG; const rowSV=floorN(v.soldValue||0,2);
              const varSWkg=(v.soldQty||0)*(varWg||0)/1000;
              totSQ+=(v.soldQty||0); totSV+=rowSV; totSWkg+=varSWkg;
              rows.push(`<tr><td class="c">${rowNum}</td><td>${esc(p.title||'')} - ${esc(v.name||'')}</td><td>${esc(p.type||'')}</td><td class="r">${esc(p.tariffNo||'')}</td><td class="r">${v.soldQty||0}</td><td class="r">${formatNum(rowSV,2)}</td><td class="r">${fmtWeightKg(varSWkg)}</td></tr>`);
            });
          } else if(c.soldQty>0){
            rowNum++; const rowSV=floorN(c.soldValue||0,2);
            totSQ+=(c.soldQty||0); totSV+=rowSV; totSWkg+=c.soldWeightKg;
            const td=hasVariants(p)?`${esc(p.title||'')} (${p.variants.length} variants)`:esc(p.title||'');
            rows.push(`<tr><td class="c">${rowNum}</td><td>${td}</td><td>${esc(p.type||'')}</td><td class="r">${esc(p.tariffNo||'')}</td><td class="r">${c.soldQty||0}</td><td class="r">${formatNum(rowSV,2)}</td><td class="r">${fmtWeightKg(c.soldWeightKg)}</td></tr>`);
          }
        });
        const fl=format==='detailed'?' (Detailed)':' (Compressed)';
        tableHtml=`<div class="section-title">List of goods sold${fl}</div>
<table class="goods"><thead><tr><th>#</th><th>Title</th><th>Type</th><th class="r">Tariff no.</th><th class="r">Qty Sold</th><th class="r">Value Sold (${cur})</th><th class="r">Sold Weight</th></tr></thead>
<tbody>${rows.join('')||'<tr><td colspan="7" style="text-align:center;color:#888;padding:8px">No sold quantities entered</td></tr>'}</tbody>
<tfoot><tr><td colspan="4" style="text-align:right">TOTALS</td><td class="r">${totSQ}</td><td class="r">${formatNum(floorN(totSV,2),2)}</td><td class="r">${fmtWeightKg(totSWkg)}</td></tr></tfoot></table>`;
      }

    // ── RETURN ──
    } else {
      let totRQ=0,totRWkg=0,totRVal=0,rowNum=0;
      let rows=[];
      if(format==='bytype'){
        const groups={};
        state.products.forEach(p=>{
          if(!hasCustomsInfo(p))return;
          const rs=calcReturnStats(p); if(rs.retQty<=0)return;
          const {retQty,retWkg,retVal}=rs;
          const key=`${p.type||'Other'}\x00${p.tariffNo||''}`;
          if(!groups[key])groups[key]={type:p.type||'Other',tariffNo:p.tariffNo||'',tariffRate:p.tariffRate,vatRate:p.vatRate,retQty:0,retWkg:0,retVal:0,hasVal:false};
          const g=groups[key];
          g.retQty+=retQty; g.retWkg+=retWkg;
          if(retVal!=null){g.retVal+=retVal; g.hasVal=true;}
          totRQ+=retQty; totRWkg+=retWkg; if(retVal!=null)totRVal+=retVal;
        });
        Object.values(groups).forEach((g,i)=>{
          rows.push(`<tr><td class="c">${i+1}</td><td><strong>${esc(g.type)}</strong></td><td class="r">${esc(g.tariffNo)}</td><td class="r">${g.tariffRate!=null?g.tariffRate+'%':''}</td><td class="r">${g.vatRate!=null?g.vatRate+'%':''}</td><td class="r"><strong>${g.retQty}</strong></td><td class="r">${fmtWeightKg(g.retWkg)}</td><td class="r">${g.hasVal?g.retVal:'—'}</td></tr>`);
        });
        tableHtml=`<div class="section-title">Return goods list (re-export) (By Type)</div>
<table class="goods"><thead><tr><th>#</th><th>Type</th><th class="r">HS Code</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="r">Return Qty</th><th class="r">Return Weight</th><th class="r">Return Value (${cur})</th></tr></thead>
<tbody>${rows.join('')||'<tr><td colspan="8" style="text-align:center;color:#888;padding:8px">All items sold - no return goods</td></tr>'}</tbody>
<tfoot><tr><td colspan="5" style="text-align:right">TOTALS</td><td class="r"><strong>${totRQ}</strong></td><td class="r">${fmtWeightKg(totRWkg)}</td><td class="r" style="color:#c00">${Math.floor(totRVal)}</td></tr></tfoot></table>`;
      } else {
        state.products.forEach(p=>{
          if(!hasCustomsInfo(p))return; const c=calcProduct(p);
          const pOrig=(p.originCountry&&p.originCountry.trim())?p.originCountry.trim().toUpperCase():(countryToCode(a.countryOfOrigin)||'');
          if(format==='detailed'&&hasVariants(p)){
            p.variants.forEach(v=>{
              const varRetQty=(v.amount||0)-(v.soldQty||0); if(varRetQty<=0)return; rowNum++;
              const varWg=v.weightG!=null?v.weightG:p.weightG; const varPrice=v.price!=null?v.price:p.price;
              const varRWkg=Math.round(varRetQty*(varWg||0))/1000; const varRVal=varPrice!=null?Math.round(varPrice*varRetQty):null;
              totRQ+=varRetQty; totRWkg+=varRWkg; if(varRVal!=null)totRVal+=varRVal;
              rows.push(`<tr><td class="c">${rowNum}</td><td>${esc(p.title||'')} - ${esc(v.name||'')}</td><td>${esc(p.type||'')}</td><td class="r">${v.amount||0}</td><td class="r">${v.soldQty||0}</td><td class="r"><strong>${varRetQty}</strong></td><td class="r">${varWg!=null?varWg+' g':''}</td><td class="r">${fmtWeightKg(varRWkg)}</td><td class="r">${p.priceNote||(varPrice!=null?formatNum(floorN(varPrice,2),2):'—')}</td><td class="r">${varRVal!=null?varRVal:'—'}</td><td class="r">${esc(p.tariffNo||'')}</td><td class="r">${p.tariffRate!=null?p.tariffRate+'%':''}</td><td class="r">${p.vatRate!=null?p.vatRate+'%':''}</td><td class="c">${esc(pOrig)}</td></tr>`);
            });
          } else {
            const rs=calcReturnStats(p); if(rs.retQty<=0)return; rowNum++;
            const {retQty,retWkg,retVal}=rs;
            const c=calcProduct(p);
            totRQ+=retQty; totRWkg+=retWkg; if(retVal!=null)totRVal+=retVal;
            const td=hasVariants(p)?`${esc(p.title||'')} (${p.variants.filter(v=>!v.unlisted).length} variants)`:esc(p.title||'');
            rows.push(`<tr><td class="c">${rowNum}</td><td>${td}</td><td>${esc(p.type||'')}</td><td class="r">${c.amount??''}</td><td class="r">${c.soldQty||0}</td><td class="r"><strong>${retQty}</strong></td><td class="r">${c.effectiveUnitWeightG!=null?Math.round(c.effectiveUnitWeightG)+' g':''}</td><td class="r">${fmtWeightKg(retWkg)}</td><td class="r">${p.priceNote||(c.effectiveUnitPrice!=null?formatNum(floorN(c.effectiveUnitPrice,2),2):'—')}</td><td class="r">${retVal!=null?retVal:'—'}</td><td class="r">${esc(p.tariffNo||'')}</td><td class="r">${p.tariffRate!=null?p.tariffRate+'%':''}</td><td class="r">${p.vatRate!=null?p.vatRate+'%':''}</td><td class="c">${esc(pOrig)}</td></tr>`);
          }
        });
        const fl=format==='detailed'?' (Detailed)':' (Compressed)';
        tableHtml=`<div class="section-title">Return goods list (re-export)${fl}</div>
<table class="goods"><thead><tr><th>#</th><th>Title</th><th>Type</th><th class="r">Original Qty</th><th class="r">Sold Qty</th><th class="r">Return Qty</th><th class="r">Unit Weight</th><th class="r">Return Weight</th><th class="r">Unit Price (${cur})</th><th class="r">Return Value (${cur})</th><th class="r">Tariff no.</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="c">Origin</th></tr></thead>
<tbody>${rows.join('')||'<tr><td colspan="14" style="text-align:center;color:#888;padding:8px">All items sold - no return goods</td></tr>'}</tbody>
<tfoot><tr><td colspan="5" style="text-align:right">TOTALS</td><td class="r"><strong>${totRQ}</strong></td><td></td><td class="r">${fmtWeightKg(totRWkg)}</td><td></td><td class="r" style="color:#c00">${Math.floor(totRVal)}</td><td colspan="4"></td></tr></tfoot></table>`;
      }
    }
    return tableHtml;
  }

  // ── Build the combined CSS ──
  const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 8pt; color: #000; padding: 12mm; }
  .doc-section { page-break-after: always; padding-bottom: 8mm; }
  .doc-section:last-child { page-break-after: auto; }
  .page-label { font-size: 9pt; font-weight: bold; color: #555; text-transform: uppercase;
                letter-spacing: 0.05em; border-bottom: 2px solid #888; padding-bottom: 3px;
                margin-bottom: 5mm; }
  .doc-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6mm; }
  .doc-top-left .doc-title { font-size: 10pt; font-weight: bold; text-transform: uppercase; }
  .doc-top-left .doc-subtitle { font-size: 8pt; color: #444; margin-top: 2px; }
  .doc-top-right { text-align: right; }
  .doc-top-right .event-name { font-size: 11pt; font-weight: bold; }
  .doc-top-right .lrp { font-size: 8pt; margin-top: 3px; }
  .info-table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; }
  .info-table td { padding: 2px 6px; font-size: 8pt; border: 1px solid #ccc; }
  .info-table td.lbl { font-weight: bold; background: #f4f4f4; width: 130px; font-size: 7.5pt; }
  .section-title { font-weight: bold; font-size: 9pt; margin: 4mm 0 2mm 0; border-bottom: 1.5px solid #000; padding-bottom: 1mm; }
  table.goods { width: 100%; border-collapse: collapse; font-size: 7pt; }
  table.goods th { background: #e8e8e8; border: 1px solid #aaa; padding: 3px 4px; text-align: left; font-size: 6.5pt; font-weight: bold; white-space: nowrap; }
  table.goods td { border: 1px solid #ccc; padding: 2px 4px; vertical-align: middle; }
  table.goods tr:nth-child(even) td { background: #fafafa; }
  table.goods tfoot td { background: #e8e8e8; font-weight: bold; border: 1px solid #aaa; padding: 3px 4px; }
  .r { text-align: right; } .c { text-align: center; }
  .signature-section { margin-top: 8mm; }
  .signature-box { border: 1px solid #000; width: 80mm; height: 22mm; margin-top: 2mm; }
  @media print { body { padding: 0; } @page { size: A4 landscape; margin: 12mm; } }`;

  // ── Build each section ──
  const importerInfo = `<table class="info-table">
  <tr><td class="lbl">Artist / Company Name</td><td>${esc(a.companyName || '')}</td>
      <td class="lbl">Name &amp; Surname</td><td>${esc(a.fullName || '')}</td></tr>
  <tr><td class="lbl">Street &amp; House Number</td><td>${esc(a.street || '')}</td>
      <td class="lbl">Postcode &amp; City</td><td>${esc(a.postCodeCity || '')}</td></tr>
  <tr><td class="lbl">Country of Origin</td><td>${esc(a.countryOfOrigin || '')}</td>
      <td class="lbl">Phone / Mobile</td><td>${esc(a.phone || '')}</td></tr>
  <tr><td class="lbl">Email</td><td colspan="3">${esc(a.email || '')}</td></tr>
</table>`;

  function docHeader(docNum) {
    const lrp = computeLRP(docNum);
    const docTitles = {
      1: 'Auxiliary Document for the Customs Declaration - Import',
      2: 'Auxiliary Document for the Customs Declaration - Sold Goods',
      3: 'Return Goods List - Re-export Declaration',
    };
    return `<div class="doc-top">
  <div class="doc-top-left">
    <div class="doc-title">${esc(docTitles[docNum])}</div>
    <div class="doc-subtitle">${esc(fmtEventDates(m.eventDateStart, m.eventDateEnd))}${m.eventLocation ? ', ' + esc(m.eventLocation) : ''}</div>
  </div>
  <div class="doc-top-right">
    <div class="event-name">${esc(m.event || '')}</div>
    <div class="lrp">LRP: ${esc(lrp || '—')}</div>
  </div>
</div>${importerInfo}`;
  }

  const formats = ['detailed', 'compressed', 'bytype'];
  const formatLabels = { detailed: 'Detailed', compressed: 'Compressed', bytype: 'By Type' };
  const docNums = onlyDocNum ? [onlyDocNum] : [1, 2, 3];
  const docShortNames = { 1: 'Import', 2: 'Sold', 3: 'Return' };

  let sections = [];
  docNums.forEach(docNum => {
    formats.forEach(fmt => {
      const label = `${docShortNames[docNum]} - ${formatLabels[fmt]}`;
      sections.push(`<div class="doc-section">
  <div class="page-label">${esc(label)}</div>
  ${docHeader(docNum)}
  ${buildGoodsTable(docNum, fmt)}
  <div class="signature-section"><strong>Date and Signature</strong><div class="signature-box"></div></div>
</div>`);
    });
  });

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>All Documents - ${esc(m.event || 'ZollTool')}</title>
<style>${CSS}</style></head><body>
${sections.join('\n')}
</body></html>`;

  const win = window.open('', '_blank', 'width=1200,height=900');
  if (!win) { showToast('Pop-up blocked - allow pop-ups and try again.', 'error'); return; }
  win.document.write(html);
  win.document.close();
}

function printGoodsList(docNum, format = 'detailed') {
  const m   = state.meta;
  const a   = state.artist;
  const lrp = computeLRP(docNum);

  const docTitles = {
    1: 'Auxiliary Document for the Customs Declaration - Import',
    2: 'Auxiliary Document for the Customs Declaration - Sold Goods',
    3: 'Return Goods List - Re-export Declaration',
  };

  const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 8pt; color: #000; padding: 12mm; }
  .doc-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6mm; }
  .doc-top-left .doc-title { font-size: 10pt; font-weight: bold; text-transform: uppercase; }
  .doc-top-left .doc-subtitle { font-size: 8pt; color: #444; margin-top: 2px; }
  .doc-top-right { text-align: right; }
  .doc-top-right .event-name { font-size: 11pt; font-weight: bold; }
  .doc-top-right .lrp { font-size: 8pt; margin-top: 3px; }
  .info-table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; }
  .info-table td { padding: 2px 6px; font-size: 8pt; border: 1px solid #ccc; }
  .info-table td.lbl { font-weight: bold; background: #f4f4f4; width: 130px; font-size: 7.5pt; }
  .section-title { font-weight: bold; font-size: 9pt; margin: 4mm 0 2mm 0; border-bottom: 1.5px solid #000; padding-bottom: 1mm; }
  table.goods { width: 100%; border-collapse: collapse; font-size: 7pt; }
  table.goods th { background: #e8e8e8; border: 1px solid #aaa; padding: 3px 4px; text-align: left; font-size: 6.5pt; font-weight: bold; white-space: nowrap; }
  table.goods td { border: 1px solid #ccc; padding: 2px 4px; vertical-align: middle; }
  table.goods tr:nth-child(even) td { background: #fafafa; }
  table.goods tfoot td { background: #e8e8e8; font-weight: bold; border: 1px solid #aaa; padding: 3px 4px; }
  .r { text-align: right; } .c { text-align: center; }
  .mono { font-family: 'Courier New', monospace; font-size: 6.5pt; }
  .sold-head { border-left: 2px solid #666 !important; }
  td.sold-first { border-left: 2px solid #888; }
  .signature-section { margin-top: 8mm; }
  .signature-box { border: 1px solid #000; width: 80mm; height: 22mm; margin-top: 2mm; }
  @media print { body { padding: 0; } @page { size: A4 landscape; margin: 12mm; } }`;

  const header = `<div class="doc-top">
  <div class="doc-top-left">
    <div class="doc-title">${esc(docTitles[docNum] || docTitles[1])}</div>
    <div class="doc-subtitle">${esc(fmtEventDates(m.eventDateStart, m.eventDateEnd))}${m.eventLocation ? ', ' + esc(m.eventLocation) : ''}</div>
  </div>
  <div class="doc-top-right">
    <div class="event-name">${esc(m.event || '')}</div>
    <div class="lrp">LRP: ${esc(lrp || '—')}</div>
  </div>
</div>
<table class="info-table">
  <tr><td class="lbl">Artist / Company Name</td><td>${esc(a.companyName || '')}</td>
      <td class="lbl">Name &amp; Surname</td><td>${esc(a.fullName || '')}</td></tr>
  <tr><td class="lbl">Street &amp; House Number</td><td>${esc(a.street || '')}</td>
      <td class="lbl">Postcode &amp; City</td><td>${esc(a.postCodeCity || '')}</td></tr>
  <tr><td class="lbl">Country of Origin</td><td>${esc(a.countryOfOrigin || '')}</td>
      <td class="lbl">Phone / Mobile</td><td>${esc(a.phone || '')}</td></tr>
  <tr><td class="lbl">Email</td><td colspan="3">${esc(a.email || '')}</td></tr>
</table>`;

  let tableHtml = '';

  const hasCustomsInfo = p => !p.unlisted && (!!(p.tariffNo && p.tariffNo.trim()) || (p.vatRate != null && p.vatRate !== ''));

  if (docNum === 1) {
    // ── IMPORT: no sold columns ──
    let totAmt = 0, totWkg = 0, totVal = 0;
    let rowNum = 0;

    let detailedRows = [];

    if (format === 'bytype') {
      // By-type: group by type + tariff code (different HS codes are never combined)
      const groups = {};
      state.products.filter(hasCustomsInfo).forEach(p => {
        const c = calcProduct(p);
        const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}`;
        if (!groups[key]) groups[key] = {
          type: p.type || 'Other', tariffNo: p.tariffNo || '',
          tariffRate: p.tariffRate, vatRate: p.vatRate,
          amount: 0, wkg: 0, val: 0, hasVal: false,
        };
        const g = groups[key];
        g.amount += (c.amount || 0); g.wkg += c.totalWeightKg;
        if (c.totalValue != null) { g.val += c.totalValue; g.hasVal = true; }
        totAmt += (c.amount || 0); totWkg += c.totalWeightKg;
        if (c.totalValue != null) totVal += c.totalValue;
      });
      Object.values(groups).forEach((g, i) => {
        detailedRows.push(`<tr>
          <td class="c">${i+1}</td><td><strong>${esc(g.type)}</strong></td>
          <td class="r">${esc(g.tariffNo)}</td>
          <td class="r">${g.tariffRate != null ? g.tariffRate + '%' : ''}</td>
          <td class="r">${g.vatRate != null ? g.vatRate + '%' : ''}</td>
          <td class="r">${g.amount}</td>
          <td class="r">${fmtWeightKg(g.wkg)}</td>
          <td class="r">${g.hasVal ? g.val : '—'}</td></tr>`);
      });
      const rows = detailedRows.join('');
      tableHtml = `<div class="section-title">List of goods (By Type)</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Type</th><th class="r">HS Code</th>
  <th class="r">Tariff Rate</th><th class="r">VAT Rate</th>
  <th class="r">Total Amount</th><th class="r">Total Weight</th>
  <th class="r">Total Value (${getCurrency()})</th>
</tr></thead><tbody>${rows}</tbody><tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td>
  <td class="r">${totAmt}</td><td class="r">${fmtWeightKg(totWkg)}</td>
  <td class="r" style="color:#c00">${Math.floor(totVal)}</td>
</tr></tfoot></table>`;
    } else {
      state.products.filter(hasCustomsInfo).forEach(p => {
        const c = calcProduct(p);
        const pOrig = (p.originCountry && p.originCountry.trim()) ? p.originCountry.trim().toUpperCase() : (countryToCode(a.countryOfOrigin) || '');

        if (format === 'detailed' && hasVariants(p)) {
          // Detailed: each variant gets its own row (skip unlisted variants)
          p.variants.filter(v => !v.unlisted).forEach(v => {
            const i = rowNum++;
            const varWg = v.weightG != null ? v.weightG : p.weightG;
            const varPrice = v.price != null ? v.price : p.price;
            const varAmt = v.amount || 0;
            const varTotalWkg = Math.round(varAmt * (varWg || 0)) / 1000;
            const varTotalVal = varPrice != null ? Math.round(varPrice * varAmt) : null;
            const pd = p.priceNote || (varPrice != null ? formatNum(floorN(varPrice, 2), 2) : '—');
            const tv = varTotalVal != null ? varTotalVal : '—';
            totAmt += varAmt; totWkg += varTotalWkg;
            if (varTotalVal != null) totVal += varTotalVal;
            detailedRows.push(`<tr><td class="c">${i+1}</td><td>${esc(v.sku||p.sku||'')}</td><td>${esc(p.title||'')} - ${esc(v.name||'')}</td>
              <td>${p.forSale?'For Sale':'Not For Sale'}</td><td>${esc(p.type||'')}</td>
              <td class="r">${varAmt}</td><td class="r">${varWg!=null?varWg+' g':''}</td>
              <td class="r">${fmtWeightKg(varTotalWkg)}</td><td class="r">${esc(pd)}</td>
              <td class="r">${tv}</td><td class="r">${esc(p.tariffNo||'')}</td>
              <td class="r">${p.tariffRate!=null?p.tariffRate+'%':''}</td>
              <td class="r">${p.vatRate!=null?p.vatRate+'%':''}</td>
              <td class="c">${esc(pOrig)}</td></tr>`);
          });
        } else {
          // Compressed or non-variant: one row per product
          const i = rowNum++;
          const pd = p.priceNote || (c.effectiveUnitPrice != null ? formatNum(floorN(c.effectiveUnitPrice, 2), 2) : '—');
          const tv = c.totalValue != null ? c.totalValue : '—';
          totAmt += (c.amount || 0); totWkg += c.totalWeightKg;
          if (c.totalValue != null) totVal += c.totalValue;
          const titleDisplay = hasVariants(p) ? `${esc(p.title||'')} (${p.variants.filter(v=>!v.unlisted).length} variants)` : `${esc(p.title||'')}`;
          detailedRows.push(`<tr><td class="c">${i+1}</td><td>${esc(p.sku||'')}</td><td>${titleDisplay}</td>
            <td>${p.forSale?'For Sale':'Not For Sale'}</td><td>${esc(p.type||'')}</td>
            <td class="r">${c.amount??''}</td><td class="r">${c.effectiveUnitWeightG!=null?Math.round(c.effectiveUnitWeightG)+' g':''}</td>
            <td class="r">${fmtWeightKg(c.totalWeightKg)}</td><td class="r">${esc(pd)}</td>
            <td class="r">${tv}</td><td class="r">${esc(p.tariffNo||'')}</td>
            <td class="r">${p.tariffRate!=null?p.tariffRate+'%':''}</td>
            <td class="r">${p.vatRate!=null?p.vatRate+'%':''}</td>
            <td class="c">${esc(pOrig)}</td></tr>`);
        }
      });

      const rows = detailedRows.join('');
      const formatLabel = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
      tableHtml = `<div class="section-title">List of goods${formatLabel}</div>
<table class="goods"><thead><tr>
  <th>#</th><th>SKU</th><th>Title</th><th>For Sale / Not For Sale</th><th>Type</th>
  <th class="r">Amount</th><th class="r">Unit Weight</th><th class="r">Total Weight</th>
  <th class="r">Unit Price (${getCurrency()})</th><th class="r">Total Value (${getCurrency()})</th>
  <th class="r">Tariff no.</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="c">Origin</th>
</tr></thead><tbody>${rows}</tbody><tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td>
  <td class="r">${totAmt}</td><td></td><td class="r">${fmtWeightKg(totWkg)}</td><td></td>
  <td class="r" style="color:#c00">${Math.floor(totVal)}</td><td colspan="4"></td>
</tr></tfoot></table>`;
    }

  } else if (docNum === 2) {
    // ── SOLD: only sold goods ──
    let totSQ=0,totSV=0,totSWkg=0;
    let rowNum = 0;

    let detailedRows = [];

    if (format === 'bytype') {
      // By-type: group by type + tariff code (different HS codes are never combined)
      const groups = {};
      state.products.forEach(p => {
        if (!hasCustomsInfo(p)) return;
        const c = calcProduct(p);
        if (!(c.soldQty > 0)) return;
        const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}`;
        if (!groups[key]) groups[key] = {
          type: p.type || 'Other', tariffNo: p.tariffNo || '',
          tariffRate: p.tariffRate, vatRate: p.vatRate,
          soldQty: 0, soldVal: 0, soldWkg: 0,
        };
        const g = groups[key];
        g.soldQty += (c.soldQty || 0);
        g.soldVal += floorN(c.soldValue || 0, 2);
        g.soldWkg += c.soldWeightKg;
        totSQ += (c.soldQty || 0); totSV += floorN(c.soldValue || 0, 2); totSWkg += c.soldWeightKg;
      });
      Object.values(groups).forEach((g, i) => {
        detailedRows.push(`<tr>
          <td class="c">${i+1}</td><td><strong>${esc(g.type)}</strong></td>
          <td class="r">${esc(g.tariffNo)}</td>
          <td class="r">${g.tariffRate != null ? g.tariffRate + '%' : ''}</td>
          <td class="r">${g.vatRate != null ? g.vatRate + '%' : ''}</td>
          <td class="r">${g.soldQty}</td>
          <td class="r">${formatNum(floorN(g.soldVal,2),2)}</td>
          <td class="r">${fmtWeightKg(g.soldWkg)}</td></tr>`);
      });
      const rows = detailedRows.join('');
      const emptyRow = rows ? '' : `<tr><td colspan="8" style="text-align:center;color:#888;padding:8px">No sold quantities entered</td></tr>`;
      tableHtml = `<div class="section-title">List of goods sold (By Type)</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Type</th><th class="r">HS Code</th>
  <th class="r">Tariff Rate</th><th class="r">VAT Rate</th>
  <th class="r">Qty Sold</th><th class="r">Value Sold (${getCurrency()})</th>
  <th class="r">Sold Weight</th>
</tr></thead><tbody>${rows}${emptyRow}</tbody><tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td>
  <td class="r">${totSQ}</td>
  <td class="r">${formatNum(floorN(totSV,2),2)}</td>
  <td class="r">${fmtWeightKg(totSWkg)}</td>
</tr></tfoot></table>`;
    } else {
      state.products.forEach(p => {
        if (!hasCustomsInfo(p)) return;
        const c = calcProduct(p);

        if (format === 'detailed' && hasVariants(p)) {
          // Detailed: each variant gets its own row if it has sold qty (skip unlisted)
          p.variants.filter(v => !v.unlisted).forEach(v => {
            if (!(v.soldQty > 0)) return;
            rowNum++;
            const varWg = v.weightG != null ? v.weightG : p.weightG;
            const rowSV = floorN(v.soldValue || 0, 2);
            const varSoldWkg = (v.soldQty || 0) * (varWg || 0) / 1000;
            totSQ += (v.soldQty || 0); totSV += rowSV; totSWkg += varSoldWkg;
            detailedRows.push(`<tr><td class="c">${rowNum}</td><td>${esc(p.title||'')} - ${esc(v.name||'')}</td><td>${esc(p.type||'')}</td>
              <td class="r">${esc(p.tariffNo||'')}</td>
              <td class="r">${v.soldQty||0}</td>
              <td class="r">${formatNum(rowSV,2)}</td>
              <td class="r">${fmtWeightKg(varSoldWkg)}</td></tr>`);
          });
        } else if (!(c.soldQty > 0)) {
          return;
        } else {
          // Compressed or non-variant
          rowNum++;
          const rowSV = floorN(c.soldValue || 0, 2);
          totSQ += (c.soldQty || 0); totSV += rowSV; totSWkg += c.soldWeightKg;
          const titleDisplay = hasVariants(p) ? `${esc(p.title||'')} (${p.variants.filter(v=>!v.unlisted).length} variants)` : esc(p.title||'');
          detailedRows.push(`<tr><td class="c">${rowNum}</td><td>${titleDisplay}</td><td>${esc(p.type||'')}</td>
            <td class="r">${esc(p.tariffNo||'')}</td>
            <td class="r">${c.soldQty||0}</td>
            <td class="r">${formatNum(rowSV,2)}</td>
            <td class="r">${fmtWeightKg(c.soldWeightKg)}</td></tr>`);
        }
      });

      const rows = detailedRows.join('');
      const emptyRow = rows ? '' : `<tr><td colspan="7" style="text-align:center;color:#888;padding:8px">No sold quantities entered</td></tr>`;
      const formatLabel = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
      tableHtml = `<div class="section-title">List of goods sold${formatLabel}</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Title</th><th>Type</th>
  <th class="r">Tariff no.</th>
  <th class="r">Qty Sold</th><th class="r">Value Sold (${getCurrency()})</th>
  <th class="r">Sold Weight</th>
</tr></thead><tbody>${rows}${emptyRow}</tbody><tfoot><tr>
  <td colspan="4" style="text-align:right">TOTALS</td>
  <td class="r">${totSQ}</td>
  <td class="r">${formatNum(floorN(totSV,2),2)}</td>
  <td class="r">${fmtWeightKg(totSWkg)}</td>
</tr></tfoot></table>`;
    }

  } else {
    // ── EXPORT/RETURN: unsold items going back (original qty − sold qty) ──
    let totRetQty=0, totRetWkg=0, totRetVal=0;
    let rowNum = 0;

    let detailedRows = [];

    if (format === 'bytype') {
      // By-type: group by type + tariff code (different HS codes are never combined)
      const groups = {};
      state.products.forEach(p => {
        if (!hasCustomsInfo(p)) return;
        const rs = calcReturnStats(p);
        if (rs.retQty <= 0) return;
        const { retQty, retWkg, retVal } = rs;
        const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}`;
        if (!groups[key]) groups[key] = {
          type: p.type || 'Other', tariffNo: p.tariffNo || '',
          tariffRate: p.tariffRate, vatRate: p.vatRate,
          retQty: 0, retWkg: 0, retVal: 0, hasVal: false,
        };
        const g = groups[key];
        g.retQty += retQty; g.retWkg += retWkg;
        if (retVal != null) { g.retVal += retVal; g.hasVal = true; }
        totRetQty += retQty; totRetWkg += retWkg;
        if (retVal != null) totRetVal += retVal;
      });
      Object.values(groups).forEach((g, i) => {
        detailedRows.push(`<tr>
          <td class="c">${i+1}</td><td><strong>${esc(g.type)}</strong></td>
          <td class="r">${esc(g.tariffNo)}</td>
          <td class="r">${g.tariffRate != null ? g.tariffRate + '%' : ''}</td>
          <td class="r">${g.vatRate != null ? g.vatRate + '%' : ''}</td>
          <td class="r"><strong>${g.retQty}</strong></td>
          <td class="r">${fmtWeightKg(g.retWkg)}</td>
          <td class="r">${g.hasVal ? g.retVal : '—'}</td></tr>`);
      });
      const rows = detailedRows.join('');
      const emptyRow = rows ? '' : `<tr><td colspan="8" style="text-align:center;color:#888;padding:8px">All items sold - no return goods</td></tr>`;
      tableHtml = `<div class="section-title">Return goods list (re-export) (By Type)</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Type</th><th class="r">HS Code</th>
  <th class="r">Tariff Rate</th><th class="r">VAT Rate</th>
  <th class="r">Return Qty</th><th class="r">Return Weight</th>
  <th class="r">Return Value (${getCurrency()})</th>
</tr></thead><tbody>${rows}${emptyRow}</tbody><tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td>
  <td class="r"><strong>${totRetQty}</strong></td>
  <td class="r">${fmtWeightKg(totRetWkg)}</td>
  <td class="r" style="color:#c00">${Math.floor(totRetVal)}</td>
</tr></tfoot></table>`;
    } else {
      state.products.forEach(p => {
        if (!hasCustomsInfo(p)) return;
        const c = calcProduct(p);
        const pOrig = (p.originCountry && p.originCountry.trim()) ? p.originCountry.trim().toUpperCase() : (countryToCode(a.countryOfOrigin) || '');

        if (format === 'detailed' && hasVariants(p)) {
          // Detailed: each variant gets its own row if there's a return qty (skip unlisted)
          p.variants.filter(v => !v.unlisted).forEach(v => {
            const varRetQty = (v.amount || 0) - (v.soldQty || 0);
            if (varRetQty <= 0) return;
            rowNum++;
            const varWg = v.weightG != null ? v.weightG : p.weightG;
            const varPrice = v.price != null ? v.price : p.price;
            const varRetWkg = Math.round(varRetQty * (varWg||0)) / 1000;
            const varRetVal = varPrice != null ? Math.round(varPrice * varRetQty) : null;
            totRetQty += varRetQty; totRetWkg += varRetWkg;
            if (varRetVal != null) totRetVal += varRetVal;
            const pd = p.priceNote || (varPrice != null ? formatNum(floorN(varPrice, 2), 2) : '—');
            const retValStr = varRetVal != null ? varRetVal : '—';
            detailedRows.push(`<tr><td class="c">${rowNum}</td><td>${esc(p.title||'')} - ${esc(v.name||'')}</td><td>${esc(p.type||'')}</td>
              <td class="r">${v.amount||0}</td><td class="r">${v.soldQty||0}</td>
              <td class="r"><strong>${varRetQty}</strong></td>
              <td class="r">${varWg!=null?varWg+' g':''}</td>
              <td class="r">${fmtWeightKg(varRetWkg)}</td>
              <td class="r">${esc(pd)}</td>
              <td class="r">${retValStr}</td>
              <td class="r">${esc(p.tariffNo||'')}</td>
              <td class="r">${p.tariffRate!=null?p.tariffRate+'%':''}</td>
              <td class="r">${p.vatRate!=null?p.vatRate+'%':''}</td>
              <td class="c">${esc(pOrig)}</td></tr>`);
          });
        } else {
          // Compressed or non-variant
          const rs = calcReturnStats(p);
          if (rs.retQty <= 0) return;
          rowNum++;
          const { retQty, retWkg, retVal } = rs;
          totRetQty += retQty; totRetWkg += retWkg;
          if (retVal != null) totRetVal += retVal;
          const pd = p.priceNote || (c.effectiveUnitPrice != null ? formatNum(floorN(c.effectiveUnitPrice, 2), 2) : '—');
          const retValStr = retVal != null ? retVal : '—';
          const titleDisplay = hasVariants(p) ? `${esc(p.title||'')} (${p.variants.filter(v=>!v.unlisted).length} variants)` : esc(p.title||'');
          detailedRows.push(`<tr><td class="c">${rowNum}</td><td>${titleDisplay}</td><td>${esc(p.type||'')}</td>
            <td class="r">${c.amount??''}</td><td class="r">${c.soldQty||0}</td>
            <td class="r"><strong>${retQty}</strong></td>
            <td class="r">${c.effectiveUnitWeightG!=null?Math.round(c.effectiveUnitWeightG)+' g':''}</td>
            <td class="r">${fmtWeightKg(retWkg)}</td>
            <td class="r">${esc(pd)}</td>
            <td class="r">${retValStr}</td>
            <td class="r">${esc(p.tariffNo||'')}</td>
            <td class="r">${p.tariffRate!=null?p.tariffRate+'%':''}</td>
            <td class="r">${p.vatRate!=null?p.vatRate+'%':''}</td>
            <td class="c">${esc(pOrig)}</td></tr>`);
        }
      });

      const rows = detailedRows.join('');
      const emptyRow = rows ? '' : `<tr><td colspan="14" style="text-align:center;color:#888;padding:8px">All items sold - no return goods</td></tr>`;
      const formatLabel = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
      tableHtml = `<div class="section-title">Return goods list (re-export)${formatLabel}</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Title</th><th>Type</th>
  <th class="r">Original Qty</th><th class="r">Sold Qty</th><th class="r">Return Qty</th>
  <th class="r">Unit Weight</th><th class="r">Return Weight</th>
  <th class="r">Unit Price (${getCurrency()})</th><th class="r">Return Value (${getCurrency()})</th>
  <th class="r">Tariff no.</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="c">Origin</th>
</tr></thead><tbody>${rows}${emptyRow}</tbody><tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td>
  <td class="r"><strong>${totRetQty}</strong></td><td></td>
  <td class="r">${fmtWeightKg(totRetWkg)}</td><td></td>
  <td class="r" style="color:#c00">${Math.floor(totRetVal)}</td><td colspan="4"></td>
</tr></tfoot></table>`;
    }
  }

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${esc(docTitles[docNum])} -${esc(m.event || 'ZollTool')}</title>
<style>${CSS}</style></head><body>
${header}
${tableHtml}
<div class="signature-section"><strong>Date and Signature</strong><div class="signature-box"></div></div>
</body></html>`;

  const win = window.open('', '_blank', 'width=1200,height=800');
  if (!win) { showToast('Pop-up blocked - allow pop-ups and try again.', 'error'); return; }
  win.document.write(html);
  win.document.close();
}

/* =========================================================
   PROFORMA INVOICE
   ========================================================= */
function printProformaInvoice() {
  const m   = state.meta;
  const a   = state.artist;
  const cur = getCurrency();
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

  const hasCustomsInfo = p => !p.unlisted && (!!(p.tariffNo && p.tariffNo.trim()) || (p.vatRate != null && p.vatRate !== ''));
  const products = state.products.filter(hasCustomsInfo);

  const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9pt; color: #000; padding: 15mm; }
  .watermark { text-align: center; font-size: 8pt; color: #c00; font-weight: bold; letter-spacing: 1px;
               border: 1.5px solid #c00; padding: 4px 10px; display: inline-block; margin-bottom: 6mm; text-transform: uppercase; }
  .doc-title { font-size: 16pt; font-weight: bold; text-transform: uppercase; margin-bottom: 1mm; }
  .doc-subtitle { font-size: 8pt; color: #555; margin-bottom: 6mm; }
  .parties { display: flex; gap: 10mm; margin-bottom: 6mm; }
  .party { flex: 1; border: 1px solid #ccc; padding: 4mm; }
  .party-label { font-size: 7pt; font-weight: bold; text-transform: uppercase; color: #666; margin-bottom: 2mm; border-bottom: 1px solid #ddd; padding-bottom: 1mm; }
  .party-name { font-size: 10pt; font-weight: bold; margin-bottom: 1mm; }
  .party-detail { font-size: 8pt; line-height: 1.5; color: #222; }
  .meta-row { display: flex; gap: 8mm; margin-bottom: 6mm; font-size: 8pt; }
  .meta-item { }
  .meta-item .meta-label { font-weight: bold; font-size: 7pt; text-transform: uppercase; color: #666; }
  .meta-item .meta-value { font-size: 9pt; margin-top: 1px; }
  table.goods { width: 100%; border-collapse: collapse; font-size: 8pt; margin-bottom: 6mm; }
  table.goods th { background: #222; color: #fff; padding: 4px 6px; text-align: left; font-size: 7.5pt; white-space: nowrap; }
  table.goods th.r { text-align: right; }
  table.goods td { border-bottom: 1px solid #ddd; padding: 4px 6px; vertical-align: middle; }
  table.goods tr:nth-child(even) td { background: #f8f8f8; }
  table.goods tfoot td { background: #eee; font-weight: bold; border-top: 2px solid #555; padding: 5px 6px; }
  .r { text-align: right; }
  .total-box { border: 2px solid #000; display: inline-block; padding: 4mm 8mm; margin-bottom: 6mm; }
  .total-box .total-label { font-size: 8pt; text-transform: uppercase; color: #555; }
  .total-box .total-value { font-size: 14pt; font-weight: bold; }
  .declaration { font-size: 7.5pt; color: #333; border-top: 1px solid #ccc; padding-top: 4mm; margin-bottom: 6mm; line-height: 1.6; }
  .sig-block { display: inline-block; width: 100mm; }
  .sig-label { font-size: 7.5pt; color: #555; margin-bottom: 1mm; }
  .sig-line { border-top: 1px solid #000; padding-top: 2mm; font-size: 7.5pt; color: #777; margin-top: 10mm; }
  @media print { body { padding: 0; } @page { size: A4 portrait; margin: 15mm; } }`;

  let totQty = 0, totVal = 0, totWkg = 0;
  const rows = products.map((p, i) => {
    const c = calcProduct(p);
    const qty = c.amount || 0;
    const unitPrice = c.effectiveUnitPrice != null ? formatNum(floorN(c.effectiveUnitPrice, 2), 2) : (p.priceNote || '—');
    const totalVal  = c.totalValue != null ? c.totalValue : 0;
    const originCc  = (p.originCountry && p.originCountry.trim()) ? p.originCountry.trim().toUpperCase() : (countryToCode(a.countryOfOrigin) || '');
    totQty += qty;
    totVal += totalVal;
    totWkg += c.totalWeightKg;
    return `<tr>
      <td class="r">${i + 1}</td>
      <td>${esc(p.title || '')}</td>
      <td>${esc(p.tariffNo || '—')}</td>
      <td class="r">${qty}</td>
      <td class="r">${c.effectiveUnitWeightG != null ? Math.round(c.effectiveUnitWeightG) + ' g' : '—'}</td>
      <td class="r">${fmtWeightKg(c.totalWeightKg)}</td>
      <td class="r">${esc(String(unitPrice))}</td>
      <td class="r">${c.totalValue != null ? c.totalValue : '—'}</td>
      <td class="r">${originCc}</td>
    </tr>`;
  }).join('');

  const venueLines = [
    m.venueName || a.fullName || a.companyName || '',
    m.event ? 'c/o ' + m.event : '',
    m.venueStreet || '',
    [m.venuePostcode, m.venueCity].filter(Boolean).join(' '),
    m.venueCountry || '',
  ].filter(Boolean).join('<br>');

  const artistLines = [
    a.companyName || '',
    a.fullName || '',
    a.street || '',
    a.postCodeCity || '',
    a.countryOfOrigin || '',
  ].filter(Boolean).join('<br>');

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Proforma Invoice -${esc(m.event || 'ZollTool')}</title>
<style>${CSS}</style></head><body>
<div class="watermark">For Customs Clearance Purposes Only &mdash; Not for Commercial Use</div>
<div class="doc-title">Proforma Invoice</div>
<div class="doc-subtitle">This document is issued solely for customs clearance and does not constitute a commercial transaction.</div>

<div class="parties">
  <div class="party">
    <div class="party-label">Seller / Exporter</div>
    <div class="party-name">${esc(a.companyName || a.fullName || '')}</div>
    <div class="party-detail">${artistLines}</div>
  </div>
  <div class="party">
    <div class="party-label">Consignee / Importer</div>
    <div class="party-name">${esc(m.venueName || a.fullName || '')}</div>
    <div class="party-detail">${venueLines}</div>
  </div>
</div>

<div class="meta-row">
  <div class="meta-item"><div class="meta-label">Invoice Date</div><div class="meta-value">${today}</div></div>
  <div class="meta-item"><div class="meta-label">Event</div><div class="meta-value">${esc(m.event || '—')}</div></div>
  <div class="meta-item"><div class="meta-label">Event Dates</div><div class="meta-value">${esc([m.eventDateStart, m.eventDateEnd].filter(Boolean).join(' – ') || '—')}</div></div>
  <div class="meta-item"><div class="meta-label">Currency</div><div class="meta-value">${esc(cur)}</div></div>
</div>

<table class="goods">
  <thead><tr>
    <th class="r">#</th>
    <th>Description</th>
    <th>HS / Tariff Code</th>
    <th class="r">Qty</th>
    <th class="r">Unit Weight</th>
    <th class="r">Total Weight</th>
    <th class="r">Unit Value (${esc(cur)})</th>
    <th class="r">Total Value (${esc(cur)})</th>
    <th class="r">Origin</th>
  </tr></thead>
  <tbody>${rows || '<tr><td colspan="9" style="text-align:center;padding:8px;color:#888">No products with customs information</td></tr>'}</tbody>
  <tfoot><tr>
    <td></td><td style="text-align:right">TOTALS</td><td></td>
    <td class="r">${totQty}</td><td></td>
    <td class="r">${fmtWeightKg(totWkg)}</td><td></td>
    <td class="r">${Math.floor(totVal)}</td><td></td>
  </tr></tfoot>
</table>

<div class="total-box">
  <div class="total-label">Total Declared Value</div>
  <div class="total-value">${esc(cur)} ${Math.floor(totVal).toLocaleString('de-CH')}</div>
  <div class="total-label" style="margin-top:3mm">Total Gross Weight</div>
  <div class="total-value">${fmtWeightKg(totWkg)}</div>
</div>

<div class="declaration">
  <strong>Declaration:</strong> I, the undersigned, hereby certify that the information on this proforma invoice is true and correct
  and that the contents of this consignment are as stated above. This invoice is issued for customs clearance purposes only
  and does not represent a commercial sale. The goods are temporarily imported into ${esc(m.venueCountry || 'the destination country')} for exhibition/sale at
  ${esc(m.event || 'the event')} and will be re-exported or accounted for after the event.
</div>

<div class="sig-block">
  <div class="sig-label">Signature &amp; Date</div>
  <div class="sig-line">${esc(a.fullName || a.companyName || '')} &nbsp;&nbsp;·&nbsp;&nbsp; Date: _______________</div>
</div>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { showToast('Pop-up blocked - please allow pop-ups for this page.', 'error'); return; }
  w.document.write(html);
  w.document.close();
}

/* =========================================================
   11.74 GOODS GROUPING -COMPUTE / RENDER / INIT
   ========================================================= */
function compute1174Groups() {
  // ensure assignments array is in sync
  const asn = state.form1174.assignments;
  while (asn.length < state.products.length) asn.push(0);
  if (asn.length > state.products.length) asn.length = state.products.length;

  function makeGroup(products) {
    let tariffNo = '—', maxVal = -1;
    const g = { tariffNo: '—', qty: 0, weightKg: 0, value: 0, retQty: 0, retWeightKg: 0, retValue: 0 };
    products.forEach(p => {
      const c = calcProduct(p);
      g.qty      += (c.amount || 0);
      g.weightKg += c.totalWeightKg;
      if (c.totalValue != null) g.value += c.totalValue;
      const retQty = Math.max(0, (c.amount || 0) - (c.soldQty || 0));
      g.retQty      += retQty;
      g.retWeightKg += Math.round(retQty * (p.weightG || 0)) / 1000;
      if (c.effectiveUnitPrice != null) g.retValue += Math.round(c.effectiveUnitPrice * retQty);
      if (c.totalValue != null && c.totalValue > maxVal && p.tariffNo) {
        maxVal = c.totalValue; tariffNo = p.tariffNo;
      }
    });
    g.tariffNo = tariffNo;
    return g;
  }

  if (state.form1174.groupMode === 'manual') {
    const g1prods = state.products.filter((_, i) => asn[i] === 1);
    const g2prods = state.products.filter((_, i) => asn[i] !== 1);
    const g1 = makeGroup(g1prods);
    const g2 = makeGroup(g2prods);
    return { g1, g2, hasG2: g2.qty > 0, g1prods, g2prods };
  }

  // auto mode -group by tariff code, top value = g1, rest = g2
  const tariffValues = {};
  state.products.forEach(p => {
    const key = (p.tariffNo || '').trim() || '—';
    const c = calcProduct(p);
    if (!tariffValues[key]) tariffValues[key] = 0;
    if (c.totalValue != null) tariffValues[key] += c.totalValue;
  });
  const topKey = Object.entries(tariffValues).sort((a, b) => b[1] - a[1])[0]?.[0];
  const g1prods = state.products.filter(p => ((p.tariffNo || '').trim() || '—') === topKey);
  const g2prods = state.products.filter(p => ((p.tariffNo || '').trim() || '—') !== topKey);
  const g1 = makeGroup(g1prods);
  const g2 = makeGroup(g2prods);
  return { g1, g2, hasG2: g2.qty > 0, g1prods, g2prods };
}

function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


function updateRouteGuidance() {
  const el = document.getElementById('route-guidance');
  if (!el) return;

  if (!state.products.length) {
    el.innerHTML = `
      <div class="route-card route-card-neutral">
        <div class="route-header">
          <div class="route-title">Which customs route applies to you?</div>
          <div class="route-amounts">Add your products to find out</div>
        </div>
        <div class="route-subtitle">The tool will show the recommended route once you've entered your products.</div>
        <div class="route-thresholds">
          <div class="route-threshold"><span class="route-badge route-badge-green">Form 11.61</span> Recommended - VAT deposit at the border, e-dec pre-registration required</div>
          <div class="route-threshold"><span class="route-badge route-badge-amber">Form 11.74 / e-dec</span> Fallback if Form 11.61 is not available - full pre-registration at the border</div>
        </div>
      </div>`;
    return;
  }

  const { totalValue, totalWeightKg } = calcTotals();
  const deposit = Math.ceil(totalValue * 0.081);
  const fmtVal  = v => Math.round(v).toLocaleString('de-CH');
  const fmtKg   = kg => (Math.round(kg * 10) / 10).toLocaleString('de-CH');

  el.innerHTML = `
    <div class="route-card route-card-1161">
      <div class="route-header">
        <span class="route-badge route-badge-green">Form 11.61 - Recommended</span>
        <span class="route-amounts">${getCurrency()} ${fmtVal(totalValue)} · ${fmtKg(totalWeightKg)} kg</span>
      </div>
      <div class="route-title">Uncertain Sale Deposit</div>
      <div class="route-subtitle">Request Form 11.61 at the border using your goods list. A VAT deposit is held and refunded once sold items are permanently imported via e-dec.</div>
      <ol class="route-steps">
        <li>Print your <strong>Import Declaration</strong> and bring it to the border <button type="button" class="btn btn-secondary btn-sm" onclick="printGoodsList(1)">Print Import Declaration</button></li>
        <li>Stop at a <strong>manned Swiss border crossing</strong>, present your goods list, and request <strong>Form 11.61</strong> - pay a deposit of approx. <strong>CHF ${fmtVal(deposit)}</strong> (8.1% of total value) in cash or by card</li>
        <li>Attend the event and <strong>keep detailed track of sold items</strong> in the Products section</li>
        <li>After the event, print your <strong>Sold Items List</strong> and <strong>Return List</strong>, then file an <strong>e-dec</strong> to permanently import sold items (see E-dec section below) <button type="button" class="btn btn-secondary btn-sm" onclick="printGoodsList(2)">Print Sold Items List</button> <button type="button" class="btn btn-secondary btn-sm" onclick="printGoodsList(3)">Print Return List</button></li>
        <li>Pay the e-dec import VAT - at the <strong>on-site customs office</strong> (e.g. Fantasy Basel has one at the venue), or at the border or airport</li>
        <li>Once the e-dec is paid, present <strong>Form 11.61</strong> at the border on departure - the <strong>full deposit is refunded</strong></li>
      </ol>
      <div class="route-note" style="margin-bottom:8px"><strong>If Form 11.61 is not available</strong> - use Form 11.74 instead. Steps 1–4 are identical. On departure, replace step 6 with:</div>
      <ol class="route-steps" start="6">
        <li>Go to the <strong>customs office at your point of departure</strong> and present your <strong>e-dec</strong> and <strong>Form 11.74</strong></li>
        <li>Fill in and submit <strong>Form 11.87</strong> (re-export / closure) at the customs counter</li>
      </ol>
    </div>`;
}

function render1174GroupUI() {
  if (!state.form1174) return;

  // sync mode select
  const modeEl = document.getElementById('group-mode-select');
  if (modeEl) modeEl.value = state.form1174.groupMode;

  const manualUI = document.getElementById('group-manual-ui');
  const autoInfo = document.getElementById('group-auto-info');
  if (!manualUI || !autoInfo) return;

  if (state.form1174.groupMode === 'manual') {
    manualUI.style.display = '';
    autoInfo.style.display = 'none';
    renderManual1174Cards();
  } else {
    manualUI.style.display = 'none';
    autoInfo.style.display = '';
    renderAuto1174Info();
  }
  updateRouteGuidance();
  updateSectionSummaries(); // refresh section header
}

function renderManual1174Cards() {
  // ensure assignments in sync
  const asn = state.form1174.assignments;
  while (asn.length < state.products.length) asn.push(0);
  if (asn.length > state.products.length) asn.length = state.products.length;

  [1, 2, 0].forEach(groupNum => {
    const zone = document.getElementById(`group-drop-${groupNum}`);
    if (!zone) return;
    zone.innerHTML = '';
    state.products.forEach((p, i) => {
      if ((asn[i] || 0) !== groupNum) return;
      const c = calcProduct(p);
      const val = c.totalValue != null ? Math.floor(c.totalValue) : 0;
      const card = document.createElement('div');
      card.className = 'g-card';
      card.draggable = true;
      card.dataset.idx = String(i);
      card.innerHTML = `<span class="g-card-handle">&#8942;&#8942;</span>
        <span class="g-card-title">${escHtml(p.title || '(untitled)')}</span>
        <span class="g-card-hs">${escHtml(p.tariffNo || '—')}</span>
        <span class="g-card-val">${getCurrency()} ${val}</span>`;
      zone.appendChild(card);
    });
  });
  update1174GroupSummaries();
}

function update1174GroupSummaries() {
  [1, 2].forEach(groupNum => {
    const summaryEl = document.getElementById(`group-summary-${groupNum}`);
    if (!summaryEl) return;
    const asn = state.form1174.assignments;
    const inGroup = state.products.filter((_, i) => (asn[i] || 0) === groupNum);
    let qty = 0, val = 0;
    inGroup.forEach(p => {
      qty += (p.amount || 0);
      const c = calcProduct(p);
      if (c.totalValue != null) val += c.totalValue;
    });
    summaryEl.textContent = `${inGroup.length} product${inGroup.length !== 1 ? 's' : ''} · ${qty} items · ${getCurrency()} ${Math.floor(val)}`;
  });
}

function renderAuto1174Info() {
  const el = document.getElementById('group-auto-info');
  if (!el) return;
  const { g1, g2, hasG2 } = compute1174Groups();

  // show which products land in each group
  const groups = {};
  state.products.forEach(p => {
    const key = (p.tariffNo || '').trim() || '—';
    if (!groups[key]) groups[key] = { tariffNo: key, products: [], value: 0 };
    const c = calcProduct(p);
    groups[key].products.push(p);
    if (c.totalValue != null) groups[key].value += c.totalValue;
  });
  const sorted = Object.values(groups).sort((a, b) => b.value - a.value);
  const g1group = sorted[0];
  const g2groups = sorted.slice(1);

  function renderGroup(label, group, products) {
    const items = products.map(p => {
      const c = calcProduct(p);
      const val = c.totalValue != null ? Math.floor(c.totalValue) : 0;
      return `<div class="g-auto-item"><span class="g-card-title">${escHtml(p.title || '(untitled)')}</span>
        <span class="g-card-hs">${escHtml(p.tariffNo || '—')}</span>
        <span class="g-card-val">${getCurrency()} ${val}</span></div>`;
    }).join('');
    return `<div class="group-auto-col">
      <div class="group-col-header"><span class="group-col-title">${label}</span>
        <span class="group-col-summary">HS: ${escHtml(group ? group.tariffNo : '—')}</span></div>
      <div class="g-auto-list">${items || '<div class="g-auto-empty">No products</div>'}</div>
    </div>`;
  }

  const g2allProducts = g2groups.flatMap(g => g.products);
  el.innerHTML = `<div class="group-auto-preview">
    ${g1group ? renderGroup('Group 1', g1group, g1group.products) : ''}
    ${hasG2 ? renderGroup('Group 2', sorted[1], g2allProducts) : ''}
  </div>`;
}

function init1174GroupUI() {
  const modeEl = document.getElementById('group-mode-select');
  if (!modeEl) return;

  modeEl.addEventListener('change', () => {
    state.form1174.groupMode = modeEl.value;
    if (modeEl.value === 'manual') {
      // initialise assignments from auto grouping
      const asn = state.form1174.assignments;
      while (asn.length < state.products.length) asn.push(0);
      if (asn.length > state.products.length) asn.length = state.products.length;

      const groups = {};
      state.products.forEach((p, i) => {
        const key = (p.tariffNo || '').trim() || '—';
        if (!groups[key]) groups[key] = { indices: [], value: 0 };
        const c = calcProduct(p);
        groups[key].indices.push(i);
        if (c.totalValue != null) groups[key].value += c.totalValue;
      });
      const sorted = Object.values(groups).sort((a, b) => b.value - a.value);
      if (sorted[0]) sorted[0].indices.forEach(i => { asn[i] = 1; });
      sorted.slice(1).forEach(g => g.indices.forEach(i => { asn[i] = 2; }));
    }
    saveToStorage();
    render1174GroupUI();
  });

  // Drag-and-drop on the three drop zones
  const container = document.getElementById('group-manual-ui');
  if (!container) return;

  let dragIdx = null;

  container.addEventListener('dragstart', e => {
    const card = e.target.closest('.g-card');
    if (!card) return;
    dragIdx = parseInt(card.dataset.idx, 10);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  container.addEventListener('dragend', e => {
    const card = e.target.closest('.g-card');
    if (card) card.classList.remove('dragging');
    document.querySelectorAll('.group-drop-zone').forEach(z => z.classList.remove('drag-over'));
    dragIdx = null;
  });

  container.addEventListener('dragover', e => {
    const zone = e.target.closest('.group-drop-zone');
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.group-drop-zone').forEach(z => z.classList.remove('drag-over'));
    zone.classList.add('drag-over');
  });

  container.addEventListener('dragleave', e => {
    const zone = e.target.closest('.group-drop-zone');
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
  });

  container.addEventListener('drop', e => {
    const zone = e.target.closest('.group-drop-zone');
    if (!zone || dragIdx === null) return;
    e.preventDefault();
    zone.classList.remove('drag-over');
    const newGroup = parseInt(zone.dataset.group, 10);
    state.form1174.assignments[dragIdx] = newGroup;
    saveToStorage();
    renderManual1174Cards();
  });
}

/* =========================================================
   PRINT / PDF EXPORT -FORMULAR 11.74 PREVIEW
   ========================================================= */
function print1174() {
  const m = state.meta;
  const a = state.artist;
  const e = state.edec;

  // ── Data preparation ──
  const artistCC          = countryToCode(a.countryOfOrigin) || '';
  const artistCountryName = COUNTRY_BY_CODE[artistCC] || artistCC;
  const senderBlock       = [a.companyName, a.fullName, a.street, a.postCodeCity, artistCountryName]
                              .filter(Boolean).join('\n');
  const venueLines        = [m.event, m.venueStreet,
                              [m.venuePostcode, m.venueCity].filter(Boolean).join(' '), m.venueCountry || '']
                              .filter(Boolean).join('\n');

  const vehicleCC    = (e.transportationCountry || '').trim().toUpperCase();
  const transportMode = (e.transportMode || '3');
  const isAir        = transportMode === '4';
  const flightNumber = (e.flightNumber || '').trim();

  // VTS code per transport mode
  const VTS_CODE = { '1':'80', '2':'20', '3':'30', '4':'40', '5':'50', '9':'90' };
  const vtsCode  = VTS_CODE[transportMode] || '30';

  // Country: vehicle CC for road; artist CC for air, rail, and all other modes
  const field5CC       = transportMode === '3' ? (vehicleCC || artistCC) : artistCC;
  // Postal code: always the event/venue postal code
  const field5PostCode = (m.venuePostcode || '').trim() || '______';
  const field5Value    = `${vtsCode} ${field5CC || '______'} ${field5PostCode}`;

  // ── Product grouping ──
  const { g1, g2, hasG2 } = compute1174Groups();

  const allTitles = state.products.map(p => p.title).filter(Boolean).join(', ');
  const today     = new Date().toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // ── Helpers ──
  const fv  = (v, warn = false) => v
    ? `<span class="fv${warn ? ' warn' : ''}">${esc(v)}</span>`
    : `<span class="ev">——</span>`;
  const fvP = v => v ? `<span class="fv pre">${esc(v)}</span>` : `<span class="ev">——</span>`;

  function cellHead(num, label) {
    return `<div class="ch"><span class="cn">${esc(num)}</span><span class="cl">${esc(label)}</span></div>`;
  }

  function gtCell(val, align = '') {
    const s = align ? ` style="text-align:${align}"` : '';
    return val ? `<td${s}><span class="gfv">${esc(val)}</span></td>` : `<td${s}></td>`;
  }

  function gtDescRow(rowNum, f16, f17) {
    return `<tr>
      <td class="rn">${rowNum}</td>
      ${gtCell(f16)}
      ${gtCell(f17)}
    </tr>`;
  }

  function gtNumRow(rowNum, f20, f22, f23, f24, f25) {
    return `<tr>
      <td class="rn">${rowNum}</td>
      <td></td><td></td>
      ${gtCell(f20, 'center')}
      <td></td>
      ${gtCell(f22, 'right')}
      ${gtCell(f23, 'center')}
      ${gtCell(f24, 'right')}
      ${gtCell(f25, 'right')}
      <td></td><td></td>
    </tr>`;
  }

  // ── CSS ──
  const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 6.5pt; color: #000; background: #b0b0b0; }

.print-bar {
  background: #222; color: #fff; padding: 7px 14px; font-size: 10pt;
  display: flex; align-items: center; gap: 12px; position: sticky; top: 0; z-index: 9;
}
.print-bar button {
  background: #1a6ecc; color: #fff; border: none; padding: 5px 16px;
  font-size: 10pt; cursor: pointer; border-radius: 3px; font-weight: bold;
}
.print-bar .hint { font-size: 7.5pt; color: #aaa; }

.page {
  width: 210mm; min-height: 297mm; margin: 8mm auto;
  background: #fff; display: flex; border: 1px solid #444;
}

/* ── Side strips ── */
.strip {
  width: 13mm; background: #f3accc; flex-shrink: 0;
  display: flex; flex-direction: column; align-items: center;
  padding: 3mm 1mm; position: relative; overflow: hidden;
}
.strip-a { font-size: 18pt; font-weight: bold; color: #000; line-height: 1; flex-shrink: 0; }
.strip-title {
  font-size: 4.5pt; color: #000; writing-mode: vertical-rl;
  transform: rotate(180deg); margin-top: 4mm; line-height: 1.5;
  white-space: nowrap; flex-shrink: 0;
}
.strip-r .strip-a { margin-top: auto; }

/* ── Form body ── */
.fb { flex: 1; display: flex; flex-direction: column; border-left: 0.5px solid #666; border-right: 0.5px solid #666; }

/* ── Cell base ── */
.cell { border: 0.5px solid #666; padding: 1.2mm 1.5mm; position: relative; min-height: 10mm; }
.ch { display: flex; align-items: baseline; gap: 1.5mm; margin-bottom: 1mm; }
.cn { font-size: 5.5pt; font-weight: bold; color: #444; white-space: nowrap; flex-shrink: 0; }
.cl { font-size: 4.8pt; color: #555; line-height: 1.3; }
.cv { font-size: 7pt; line-height: 1.5; }

/* Pre-filled values */
.fv     { font-weight: bold; color: #003ab5; }
.fv.pre { white-space: pre-wrap; }
.fv.warn { font-weight: bold; color: #cc0000; }
.ev     { color: #bbb; font-style: italic; }
.warn-note { font-size: 5pt; color: #cc0000; font-style: italic; margin-top: 1mm; }

/* ── Header row ── */
.hdr { display: flex; border-bottom: 0.5px solid #666; align-items: stretch; }
.hdr-admin { flex: 0 0 auto; padding: 1.5mm 2mm; font-size: 4.8pt; line-height: 1.5; border-right: 0.5px solid #666; }
.hdr-copy  { flex: 1; padding: 1.5mm 2mm; font-size: 5pt; display: flex; align-items: flex-end; }
.hdr-num   { flex: 0 0 auto; padding: 1.5mm 3mm; border-left: 0.5px solid #666; text-align: right; }
.form-number { font-size: 22pt; font-weight: bold; line-height: 1; }
.form-ref    { font-size: 4.5pt; color: #666; }

/* ── Top section (fields 1-13) ── */
.top { display: flex; border-bottom: 0.5px solid #666; }
.lc  { flex: 0 0 56%; border-right: 0.5px solid #666; display: flex; flex-direction: column; }
.lc .cell { border: none; border-bottom: 0.5px solid #666; flex: 1; }
.lc .cell:last-child { border-bottom: none; }

.rc { flex: 1; display: flex; flex-direction: column; }
.rc .cell { border: none; border-bottom: 0.5px solid #666; }
.rc .cell:last-child { border-bottom: none; flex: 1; }
.rc-top { display: flex; border-bottom: 0.5px solid #666; }
.rc-top .cell { border: none; flex: 1; }
.rc-top .cell:first-child { border-right: 0.5px solid #666; }

/* ── Field 4/5 / 14/15 section ── */
.mid { display: flex; border-bottom: 0.5px solid #666; }
.ml { flex: 0 0 56%; border-right: 0.5px solid #666; display: flex; flex-direction: column; }
.ml .cell { border: none; border-bottom: 0.5px solid #666; }
.ml .cell:last-child { border-bottom: none; flex: 1; }
.mr { flex: 1; display: flex; flex-direction: column; }
.mr .cell { border: none; border-bottom: 0.5px solid #666; }
.mr .cell:last-child { border-bottom: none; flex: 1; }

.cb-row { display: flex; gap: 3mm; flex-wrap: wrap; margin: 1mm 0; }
.cb { display: inline-flex; align-items: center; gap: 1mm; font-size: 5pt; color: #333; }
.cb-box { width: 3mm; height: 3mm; border: 0.5px solid #555; display: inline-block; flex-shrink: 0; background: #fff; }
.cb-box.chk { background: #000; }
.f4sub { font-size: 5pt; color: #555; margin-top: 1mm; line-height: 1.7; }

/* ── Goods table ── */
.gt-wrap { border-bottom: 0.5px solid #666; }
table.gt {
  width: 100%; border-collapse: collapse; font-size: 5pt; table-layout: fixed;
}
table.gt th, table.gt td {
  border: 0.5px solid #666; padding: 0.8mm 1mm; vertical-align: top;
}
table.gt th { font-weight: bold; font-size: 4.8pt; line-height: 1.3; background: #fff; }
table.gt td { height: 16mm; vertical-align: top; }
td.rn    { text-align: center; font-size: 8pt; font-weight: bold; vertical-align: top; padding-top: 1.5mm; }
.gfv     { font-weight: bold; color: #003ab5; font-size: 5.5pt; white-space: pre-wrap; }
.th-hint { display: block; font-size: 4pt; color: #c00; font-weight: normal; margin-top: 1mm; line-height: 1.3; }

/* Description table (16 + 17) column widths */
col.d-rn { width: 3%; }
col.d-16 { width: 14%; }
/* col.d-17 fills remaining */

/* Numeric table (18–27) column widths -must total 100% */
col.n-rn { width: 3%; }
col.n-18 { width: 5%; }
col.n-19 { width: 5%; }
col.n-20 { width: 15%; }
col.n-21 { width: 6%; }
col.n-22 { width: 12%; }
col.n-23 { width: 11%; }
col.n-24 { width: 13%; }
col.n-25 { width: 15%; }
col.n-26 { width: 7.5%; }
col.n-27 { width: 7.5%; }

/* ── Bottom section ── */
.bot { display: flex; flex: 1; }
.bl  { flex: 0 0 56%; border-right: 0.5px solid #666; display: flex; flex-direction: column; }
.bl .cell { border: none; border-bottom: 0.5px solid #666; }
.bl .cell:last-child { border-bottom: none; flex: 1; }
.br  { flex: 1; display: flex; flex-direction: column; }
.br .cell { border: none; border-bottom: 0.5px solid #666; }
.br .cell:last-child { border-bottom: none; flex: 1; }

/* Horizontal field: label left, value right */
.hfield { display: flex; align-items: center; gap: 2mm; }
.hfield-label { flex: 1; }
.hfield-value { flex: 0 0 auto; font-size: 8pt; font-weight: bold; color: #003ab5;
                border-left: 0.5px solid #ccc; padding-left: 2mm; min-width: 10mm; text-align: center; }

.sig-line { border-bottom: 0.5px solid #888; min-height: 10mm; margin-top: 1.5mm; }
.sig-note { font-size: 4.8pt; color: #cc0000; font-style: italic; margin-top: 0.8mm; }
.subtotal-label { font-size: 4.8pt; color: #555; margin: 1.5mm 0 0.5mm 0; }

@media print {
  .print-bar { display: none; }
  body { background: #fff; }
  .page { margin: 0; border: none; box-shadow: none; }
  @page { size: A4 portrait; margin: 0mm; }
}`;

  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<title>Formular 11.74 -${esc(m.event || 'ZollTool')}</title>
<style>${CSS}</style></head><body>

<div class="print-bar">
  <button onclick="window.print()">🖨&nbsp; Print / Save as PDF</button>
  <span class="hint">Pre-filled values shown in <strong style="color:#6699ee">bold blue</strong> &nbsp;·&nbsp; Verify all fields before signing &nbsp;·&nbsp; ${esc(m.event || '')} &nbsp;·&nbsp; Generated ${today}</span>
</div>

<div class="page">

  <!-- Left pink strip -->
  <div class="strip">
    <div class="strip-a">A</div>
    <div class="strip-title">Vorübergehende Verwendung mit hinterlegtem Betrag · Admission temporaire à montant déposé · Ammissione temporanea con importo depositato</div>
  </div>

  <!-- Form body -->
  <div class="fb">

    <!-- Header -->
    <div class="hdr">
      <div class="hdr-admin">
        Eidgenössische Zollverwaltung EZV<br>
        Administration fédérale des douanes AFD<br>
        Amministrazione federale delle dogane AFD
      </div>
      <div class="hdr-copy">Kopie für / Copie pour / Copia per &nbsp;→</div>
      <div class="hdr-num">
        <div class="form-number">11.74</div>
        <div class="form-ref">606.000.11.74</div>
      </div>
    </div>

    <!-- Fields 1–13 -->
    <div class="top">
      <div class="lc">
        <div class="cell">
          ${cellHead('1', 'Versender / Expéditeur / Speditore')}
          <div class="cv">${fvP(senderBlock)}</div>
        </div>
        <div class="cell">
          ${cellHead('2', 'Eigentümer der Ware / Propriétaire de la marchandise / Proprietario della merce')}
          <div class="cv">${fvP(senderBlock)}</div>
        </div>
        <div class="cell">
          ${cellHead('3', 'Empfänger/Importeur / Destinataire/Importateur / Destinatario/Importatore')}
          <div class="cv">${fvP(venueLines)}</div>
        </div>
      </div>
      <div class="rc">
        <div class="rc-top">
          <div class="cell">
            ${cellHead('6', 'Vordokument / Document précédent / Documento precedente')}
            <div class="cv">${isAir && flightNumber ? fv(flightNumber) : '<span style="font-size:5pt;color:#888">Nr. / No / N. ___________</span>'}</div>
          </div>
          <div class="cell">
            ${cellHead('7', 'Konto-Nr. / Compte No / Conto N.')}
            <div class="cv"><span class="ev">——</span></div>
          </div>
        </div>
        <div class="cell" style="min-height:7mm">
          ${cellHead('8', 'Einfuhr / Import. / Import')}
          <div class="cv">
            <span class="cb"><span class="cb-box chk"></span> Einfuhr / Import. / Import</span>
            &nbsp;&nbsp;
            <span class="cb"><span class="cb-box"></span> Ausfuhr / Export. / Esport.</span>
          </div>
        </div>
        <div class="cell" style="min-height:7mm">
          ${cellHead('9', 'Verfalldatum / Echéance / Scadenza')}
          <div class="cv"><span class="ev">——</span></div>
        </div>
        <div class="cell hfield" style="min-height:7mm">
          <div class="hfield-label">${cellHead('10', 'Ursprungsland / Pays d\'origine / Paese d\'origine')}</div>
          <div class="hfield-value">${fv(artistCC)}</div>
        </div>
        <div class="cell hfield" style="min-height:7mm">
          <div class="hfield-label">${cellHead('11', 'Land der vorübergehenden Bestimmung / Pays de destination temporaire / Paese di destinazione temporanea')}</div>
          <div class="hfield-value">${fv(countryToCode(m.venueCountry) || 'CH')}</div>
        </div>
        <div class="cell hfield" style="min-height:7mm">
          <div class="hfield-label">${cellHead('12', 'Land der endgültigen Bestimmung / Pays de destination définitive / Paese di destinazione definitiva')}</div>
          <div class="hfield-value">${fv(artistCC)}</div>
        </div>
        <div class="cell">
          ${cellHead('13', 'Verwendungszweck der Ware / Emploi de la marchandise / Scopo d\'impiego della merce')}
          <div class="cv">${fv('Verkauf an Ausstellungen / Messen · Vente aux expositions / foires')}</div>
        </div>
      </div>
    </div>

    <!-- Field 4 / 5 + 14 / 15 -->
    <div class="mid">
      <div class="ml">
        <div class="cell">
          ${cellHead('4', 'Präferenzbehandlung / Régime préférentiel / Trattamento preferenziale')}
          <div class="cb-row">
            <span class="cb"><span class="cb-box"></span> Europäische Freihandelszone / Zone européenne de libre-échange / Zona europea di libero scambio</span>
          </div>
          <div class="cb-row">
            <span class="cb"><span class="cb-box"></span> Allgemeines Präferenzsystem / Système généralisé de préférences / Sistema generale di preferenze</span>
          </div>
          <div class="f4sub">
            WVB/UZ Nr. _________ vom / CCM/CO No _________ du / CCM/CO N. _________ del
          </div>
        </div>
        <div class="cell">
          ${cellHead('5', 'VTS/SMT · Immat. Land / Pays d\'immatr. / Paese d\'immatr. · PLZ/NPA/CAP')}
          <div style="display:flex;gap:2mm;align-items:flex-start;margin-top:1mm">
            <div style="flex:0 0 auto;border-right:0.5px solid #ccc;padding-right:2mm">
              <div style="font-size:4pt;color:#666;margin-bottom:0.5mm">VTS/SMT</div>
              <span class="fv">${esc(vtsCode)}</span>
            </div>
            <div style="flex:0 0 auto;border-right:0.5px solid #ccc;padding-right:2mm">
              <div style="font-size:4pt;color:#666;margin-bottom:0.5mm">Immat. Land / Pays / Paese</div>
              <span class="fv">${esc(field5CC || '______')}</span>
            </div>
            <div style="flex:0 0 auto">
              <div style="font-size:4pt;color:#666;margin-bottom:0.5mm">PLZ/NPA/CAP</div>
              <span class="fv">${esc(field5PostCode)}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="mr">
        <div class="cell" style="min-height:8mm">
          ${cellHead('14', 'Mietgeschäft / Location / Locazione')}
          <div class="cv">
            <span class="cb"><span class="cb-box"></span> ja / oui / sì</span>
            &nbsp;&nbsp;
            <span class="cb"><span class="cb-box"></span> nein / non / no</span>
          </div>
        </div>
        <div class="cell">
          ${cellHead('15', 'Abschlusszollstelle / Bureau de douane d\'apurement / Ufficio doganale della conclusione')}
          <div class="cv"><span class="ev">——</span></div>
        </div>
      </div>
    </div>

    <!-- Goods table: 16 + 17 (description) -->
    <div class="gt-wrap" style="border-bottom:none">
      <table class="gt">
        <colgroup>
          <col class="d-rn"><col class="d-16"><!-- d-17 fills rest -->
        </colgroup>
        <thead><tr>
          <th></th>
          <th>16 Zeichen, Nr., Anzahl, Verpackung<br>Marque, no, nombre, emballage<br>Marca, n., quantità, imballaggio</th>
          <th>17 Genaue Warenbezeichnung (Material, Typ, Nummern, etc.), die eine Identifikation der Ware sicherstellt<br>Désignation exacte de la marchandise (matière, type, numéros, etc.) garantissant son identification<br>Designazione esatta della merce (materiale, tipo, numeri, ecc.), che garantisce l'identificazione della merce</th>
        </tr></thead>
        <tbody>
          ${gtDescRow(1, 'see attached list', allTitles || '—')}
          ${hasG2 ? gtDescRow(2, '', '') : ''}
        </tbody>
      </table>
    </div>

    <!-- Goods table: 18–27 (numeric columns) -->
    <div class="gt-wrap">
      <table class="gt">
        <colgroup>
          <col class="n-rn"><col class="n-18"><col class="n-19"><col class="n-20">
          <col class="n-21"><col class="n-22"><col class="n-23">
          <col class="n-24"><col class="n-25"><col class="n-26"><col class="n-27">
        </colgroup>
        <thead><tr>
          <th></th>
          <th>18<br>NHW<br>MNC<br><span class="th-hint">Statistical goods code - leave blank if unknown</span></th>
          <th>19<br>VC<br>CT<br><span class="th-hint">Mode of transport carrier code - leave blank</span></th>
          <th>20 Tarif-Nr.<br>No de tarif<br>Voce di tariffa<br><span class="th-hint">HS tariff number of the goods</span></th>
          <th>21<br>Schlüssel<br>Clé<br>N.conv.<br><span class="th-hint">Quantity unit/conversion key - leave blank</span></th>
          <th>22 Eigenmasse<br>Masse nette<br>Massa netta<br><span class="th-hint">Net weight in kg (without packaging)</span></th>
          <th>23 Zusatzmenge<br>Unités suppl.<br>Unità suppl.<br><span class="th-hint">Total number of individual items</span></th>
          <th>24 Rohmasse<br>Masse brute<br>Massa lorda<br><span class="th-hint">Gross weight in kg (incl. packaging)</span></th>
          <th>25 Stat. Wert in CHF<br>Valeur stat. CHF<br>Valore stat. CHF<br><span class="th-hint">Total value in CHF (numbers only, no currency symbol)</span></th>
          <th>26 Ansatz<br>Taux<br>Aliquota<br><span class="th-hint">Duty rate in % - customs fills this in</span></th>
          <th>27 Betrag<br>Montant<br>Importo<br><span class="th-hint">Duty amount in CHF - customs fills this in</span></th>
        </tr></thead>
        <tbody>
          ${gtNumRow(1,
              g1.tariffNo !== '—' ? g1.tariffNo : '',
              String(Math.round(g1.weightKg)),
              String(g1.qty),
              String(Math.round(g1.weightKg)),
              String(Math.floor(g1.value)))}
          ${hasG2 ? gtNumRow(2,
              g2.tariffNo !== '—' ? g2.tariffNo : '',
              String(Math.round(g2.weightKg)),
              String(g2.qty),
              String(Math.round(g2.weightKg)),
              String(Math.floor(g2.value))) : ''}
        </tbody>
      </table>
    </div>

    <!-- Bottom: 28–31 + 32 -->
    <div class="bot">
      <div class="bl">
        <div class="cell" style="min-height:8mm">
          ${cellHead('28', 'Verwender der Ware / Utilisateur de la marchandise / Utilizzatore della merce')}
          <div class="cv"><span class="ev">——</span></div>
        </div>
        <div class="cell" style="min-height:8mm">
          ${cellHead('29', 'MWST-Nr. / No TVA / N. IVA &nbsp;&nbsp; MWST-Code / Code-TVA / Codice-IVA')}
          <div class="cv"><span class="ev">——</span></div>
        </div>
        <div class="cell" style="min-height:8mm">
          ${cellHead('30', 'Bewilligung usw. / Permis, etc. / Permesso, ecc.')}
          <div class="cv"><span class="ev">——</span></div>
        </div>
        <div class="cell">
          ${cellHead('31', 'Ort/Datum · Lieu/date · Luogo/data &nbsp;&nbsp; Der Anmelder / Le déclarant / Il dichiarante &nbsp;&nbsp; Ref. / Réf. / Rif.')}
          <div style="display:flex;gap:4mm;margin-top:1mm">
            <div style="flex:0 0 auto">
              <div style="font-size:4.8pt;color:#555">Ort/Datum</div>
              <div class="fv" style="font-size:7pt">${esc(today)}</div>
            </div>
            <div style="flex:1">
              <div style="font-size:4.8pt;color:#555">Der Anmelder / Le déclarant / Il dichiarante</div>
              <div class="fv" style="font-size:7pt">${esc(a.fullName || '—')}</div>
              <div class="sig-note">→ Recommended: person paying the customs deposit</div>
            </div>
            <div style="flex:1">
              <div style="font-size:4.8pt;color:#555">Unterschrift / Signature / Firma</div>
              <div class="sig-line"></div>
              <div class="sig-note">→ Recommended: person paying the customs deposit</div>
            </div>
          </div>
        </div>
      </div>
      <div class="br">
        <div class="cell" style="min-height:14mm">
          ${cellHead('32', 'Zollabgaben / Droits de douane / Tributi doganali')}
          <div class="cv"><span class="ev">——</span></div>
        </div>
        <div class="cell">
          <div class="subtotal-label">Subtotal / Total int. / Subtotale</div>
          <div class="cv"><span class="ev">——</span></div>
          <div class="subtotal-label">Einfuhrabgaben / Redevances d'entrée / Diritti d'entrata</div>
          <div class="cv"><span class="ev">——</span></div>
          <div class="subtotal-label">Annahme / Acceptation / Accettazione</div>
          <div class="cv"><span class="ev">——</span></div>
        </div>
      </div>
    </div>

  </div>

  <!-- Right pink strip -->
  <div class="strip strip-r">
    <div class="strip-a">A</div>
  </div>

</div>
</body></html>`;

  const win = window.open('', '_blank', 'width=960,height=1000');
  if (!win) { showToast('Pop-up blocked - allow pop-ups and try again.', 'error'); return; }
  win.document.write(html);
  win.document.close();
}

/* =========================================================
   PRINT / PDF EXPORT -FORMULAR 11.87 PREVIEW
   ========================================================= */
function print1187() {
  const m = state.meta;
  const a = state.artist;
  const e = state.edec;

  const artistCC          = countryToCode(a.countryOfOrigin) || '';
  const artistCountryName = COUNTRY_BY_CODE[artistCC] || artistCC;
  const senderBlock       = [a.companyName, a.fullName, a.street, a.postCodeCity, artistCountryName]
                              .filter(Boolean).join('\n');

  const transportMode = (e.transportMode || '3');
  const vehicleCC     = (e.transportationCountry || '').trim().toUpperCase();
  const VTS_CODE      = { '1':'80', '2':'20', '3':'30', '4':'40', '5':'50', '9':'90' };
  const vtsCode       = VTS_CODE[transportMode] || '30';
  const field12CC     = transportMode === '3' ? (vehicleCC || artistCC) : artistCC;
  const field12PLZ    = (m.venuePostcode || '').trim() || '______';
  const eventBlock    = [m.event, m.venueStreet,
                          [m.venuePostcode, m.venueCity].filter(Boolean).join(' '), m.venueCountry || '']
                          .filter(Boolean).join('\n');

  const today     = new Date().toLocaleDateString('de-CH', { day:'2-digit', month:'2-digit', year:'numeric' });
  const eventCity = m.venueCity || '';

  const { g1, g2, hasG2, g1prods, g2prods } = compute1174Groups();

  const X = v => String(v == null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fv  = v => v ? `<span class="fv">${X(v)}</span>` : `<span class="ev">——</span>`;
  const fvP = v => v ? `<span class="fv pre">${X(v)}</span>` : `<span class="ev">——</span>`;
  function ch(num, label) {
    return `<div class="ch"><span class="cn">${num}</span><span class="cl">${label}</span></div>`;
  }
  function gcell(v, align) {
    return v ? `<td style="text-align:${align||'right'}"><span class="gfv">${X(String(v))}</span></td>` : '<td></td>';
  }

  // Build description for a group
  function groupDesc(prods) {
    if (!prods || !prods.length) return '';
    return [...new Set(prods.map(p => p.title || p.type).filter(Boolean))].join(', ');
  }
  // Build packaging field (field 13): "N CT" using most common packaging type
  function groupPkg(prods) {
    if (!prods || !prods.length) return '';
    const pkgCount = {};
    prods.forEach(p => { const t = p.packagingType || 'CT'; pkgCount[t] = (pkgCount[t] || 0) + 1; });
    const pkg = Object.entries(pkgCount).sort((a,b) => b[1]-a[1])[0]?.[0] || 'CT';
    const boxes = prods.length;
    return `${boxes} ${pkg}`;
  }

  const g1Desc = groupDesc(g1prods); const g1Pkg = groupPkg(g1prods);
  const g2Desc = groupDesc(g2prods); const g2Pkg = groupPkg(g2prods);

  // Build field 14 description: titles of products not completely sold out
  const allRetProds  = [...(g1prods || []), ...(hasG2 ? g2prods || [] : [])];
  const allRetTitles = allRetProds
    .filter(p => Math.max(0, (p.amount || 0) - (p.soldQty || 0)) > 0)
    .map(p => p.title)
    .filter(Boolean)
    .join(', ');

  const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 6pt; color: #000; background: #b0b0b0; }
.print-bar { background:#222; color:#fff; padding:7px 14px; font-size:10pt; display:flex; align-items:center; gap:12px; position:sticky; top:0; z-index:9; }
.print-bar button { background:#1a6ecc; color:#fff; border:none; padding:5px 16px; font-size:10pt; cursor:pointer; border-radius:3px; font-weight:bold; }
.print-bar .hint { font-size:7.5pt; color:#aaa; }
.page { width:210mm; min-height:297mm; margin:8mm auto; background:#fff; display:flex; flex-direction:column; border:1px solid #444; }

/* Header */
.hdr { display:flex; border-bottom:0.5px solid #000; flex-shrink:0; }
.hdr-logo { width:68mm; padding:2mm; border-right:0.5px solid #000; font-size:4.5pt; line-height:1.4; }
.hdr-logo strong { font-size:5pt; }
.hdr-copy { flex:1; padding:2mm 3mm; border-right:0.5px solid #000; font-size:5pt; }
.hdr-num { padding:2mm 4mm; display:flex; align-items:center; }
.form-number { font-size:30pt; font-weight:bold; letter-spacing:1pt; }

/* Body wrapper */
.body-wrap { display:flex; flex:1; }
.strip { width:13mm; background:#009f68; flex-shrink:0; display:flex; flex-direction:column; align-items:center; padding:3mm 1mm; }
.strip-a { font-size:18pt; font-weight:bold; color:#000; line-height:1; flex-shrink:0; }
.strip-title { font-size:4.5pt; color:#000; writing-mode:vertical-rl; transform:rotate(180deg); margin-top:4mm; line-height:1.5; white-space:nowrap; flex-shrink:0; }
.strip-instr { font-size:3.8pt; color:#000; writing-mode:vertical-rl; transform:rotate(180deg); margin-top:auto; line-height:1.4; white-space:nowrap; flex-shrink:0; }
.fb { flex:1; display:flex; flex-direction:column; }

/* Top grid */
.top-grid { display:flex; border-bottom:0.5px solid #666; }
.lc { flex:0 0 46%; border-right:0.5px solid #666; display:flex; flex-direction:column; }
.rc { flex:1; display:flex; flex-direction:column; }
.hfield { display:flex; gap:2mm; align-items:flex-start; }
.hfield-label { flex:1; }
.hfield-value { flex:0 0 12mm; text-align:right; }
.sig-note { font-size:4pt; color:#cc0000; margin-top:0.5mm; font-style:italic; }

.cell { border-bottom:0.5px solid #666; padding:1mm 1.5mm; }
.cell:last-child { border-bottom:none; }
.ch { display:flex; align-items:baseline; gap:1mm; margin-bottom:0.5mm; }
.cn { font-size:6pt; font-weight:bold; flex-shrink:0; }
.cl { font-size:4pt; color:#555; line-height:1.3; }
.fv { font-weight:bold; color:#003ab5; font-size:7pt; }
.fv.pre { white-space:pre-wrap; font-size:6.5pt; }
.ev { font-size:5.5pt; color:#aaa; font-style:italic; }
.cb { font-size:5pt; display:inline-flex; align-items:center; gap:1mm; margin-right:2.5mm; }
.cb-box { display:inline-block; width:3mm; height:3mm; border:0.5px solid #000; flex-shrink:0; background:#fff; }
.cb-box.chk { background:#000; }

/* Row splitting in rc */
.rc-row { display:flex; border-bottom:0.5px solid #666; }
.rc-row:last-child { border-bottom:none; }
.rc-row .cell { border-bottom:none; }
.rc-row .cell + .cell { border-left:0.5px solid #666; }

/* Field 12 horizontal */
.f12-seg { flex:0 0 auto; border-right:0.5px solid #ccc; padding-right:2mm; margin-right:2mm; }
.f12-seg:last-child { border-right:none; }
.f12-lbl { font-size:3.8pt; color:#666; margin-bottom:0.5mm; }

/* Goods table */
.gt-wrap { border-top:0.5px solid #666; }
.gt { width:100%; border-collapse:collapse; table-layout:fixed; }
.gt th, .gt td { border:0.5px solid #777; padding:0.5mm 0.8mm; vertical-align:top; font-size:4.5pt; }
.gt th { font-weight:600; background:#f4f4f4; line-height:1.3; }
.gt .rn { width:4mm; text-align:center; font-weight:bold; font-size:6pt; }
.gt .data-row td { height:14mm; }
.gfv { font-size:7pt; font-weight:bold; color:#003ab5; }

/* Footer */
.footer { display:flex; border-top:0.5px solid #666; }
.f24 { flex:0 0 52%; border-right:0.5px solid #666; padding:1.5mm; }
.f25 { flex:1; padding:1.5mm; }
.sig-line { border-top:0.5px solid #888; margin-top:5mm; padding-top:0.5mm; font-size:4pt; color:#888; }
.customs-bar { border-top:0.5px solid #666; padding:1mm 1.5mm; font-size:4.5pt; color:#555; }
.customs-boxes { display:flex; gap:3mm; margin-top:1mm; }
.customs-box { flex:1; border:0.5px solid #aaa; min-height:12mm; padding:0.5mm 1mm; font-size:4pt; color:#888; }
.form-footer { text-align:center; font-size:4.5pt; color:#777; padding:1mm; border-top:0.5px solid #eee; }
@media print {
  .print-bar { display:none; }
  body { background:#fff; }
  .page { margin:0; border:none; }
  @page { size: A4 portrait; margin: 0mm; }
}`;

  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<title>Formular 11.87 -${X(m.event || 'ZollTool')}</title>
<style>${CSS}</style></head><body>
<div class="print-bar">
  <button onclick="window.print()">Print / Save PDF</button>
  <span class="hint">Formular 11.87 - Vorübergehende Verwendung / Abschluss · pre-filled preview</span>
</div>
<div class="page">

  <!-- Header -->
  <div class="hdr">
    <div class="hdr-logo">
      &#x2295; Schweizerische Eidgenossenschaft · Confédération suisse · Confederazione Svizzera · Confederaziun svizra<br><br>
      <strong>Bundesamt für Zoll und Grenzsicherheit BAZG</strong><br>
      Office fédéral de la douane et de la sécurité des frontières OFDF<br>
      Ufficio federale della dogana e della sicurezza dei confini UDSC<br>
      Uffizi federal da la duana e da la segirezza dals cunfins UDSC
    </div>
    <div class="hdr-copy">Kopie für<br>Copie pour<br>Copia per &nbsp; ________________________</div>
    <div class="hdr-num"><div class="form-number">11.87</div></div>
  </div>

  <!-- Body -->
  <div class="body-wrap">
    <div class="strip">
      <div class="strip-a">A</div>
      <div class="strip-title">Vorübergehende Verwendung / Abschluss · Admission temporaire / Apurement · Ammissione temporanea / Conclusione</div>
      <div class="strip-instr">Anleitung für das Ausfüllen siehe Rückseite von Abschnitt C · Directives pour l'établissement, voir au verso du feuillet C · Istruzioni per l'allestimento, vedi a tergo della cedola C</div>
    </div>
    <div class="fb">

      <!-- Top grid -->
      <div class="top-grid">
        <!-- Left column: 1, 2, 3, 4 -->
        <div class="lc">
          <div class="cell" style="min-height:22mm">
            ${ch('1','Versender / Expéditeur / Speditore')}
            ${fvP(eventBlock)}
          </div>
          <div class="cell" style="min-height:12mm">
            ${ch('2','Eigentümer der Ware / Propriétaire de la marchandise / Proprietario della merce')}
            ${fvP(senderBlock)}
          </div>
          <div class="cell" style="min-height:12mm">
            ${ch('3','Empfänger/Importeur/Verwender / Destinataire/Importateur/Utilisateur / Destinatario/Importatore/Utilizzatore')}
            ${fvP(senderBlock)}
          </div>
          <div class="cell" style="min-height:16mm; border-bottom:none; flex:1">
            ${ch('4','ab 11.73/11.74')}
            <div style="font-size:5pt; line-height:2.4; color:#333; margin-top:1mm">
              Nr. / No / N. &nbsp;<span style="border-bottom:0.5px solid #999;display:inline-block;min-width:28mm">&nbsp;</span><br>
              vom / du / del &nbsp;<span style="border-bottom:0.5px solid #999;display:inline-block;min-width:24mm">&nbsp;</span><br>
              Zollstelle &nbsp;<span style="border-bottom:0.5px solid #999;display:inline-block;min-width:18mm">&nbsp;</span>
            </div>
          </div>
        </div>

        <!-- Right column: 5–12 -->
        <div class="rc">
          <div class="rc-row" style="min-height:14mm">
            <div class="cell" style="flex:1">
              ${ch('5','Vordokument / Document précédent / Documento precedente')}
              <div style="margin-top:1mm; font-size:5pt; color:#333">
                Nr. / No / N. &nbsp;<span style="border-bottom:0.5px solid #999;display:inline-block;min-width:22mm">&nbsp;</span>
              </div>
            </div>
            <div class="cell" style="flex:0 0 36mm">
              ${ch('6','Einfuhr / Import. &nbsp;&nbsp; Ausfuhr / Export.')}
              <div style="margin-top:1.5mm">
                <span class="cb"><span class="cb-box"></span> Einfuhr</span>
                <span class="cb"><span class="cb-box chk"></span> Ausfuhr</span>
              </div>
            </div>
          </div>
          <div class="cell hfield" style="min-height:7mm">
            <div class="hfield-label">${ch('7','Ursprungsland / Pays d\'origine / Paese d\'origine')}</div>
            <div class="hfield-value">${fv(artistCC || '——')}</div>
          </div>
          <div class="cell hfield" style="min-height:7mm">
            <div class="hfield-label">${ch('8','Land der vorübergehenden Bestimmung / Pays de destination temporaire / Paese di destinazione temporanea')}</div>
            <div class="hfield-value">${fv(countryToCode(m.venueCountry) || 'CH')}</div>
          </div>
          <div class="cell hfield" style="min-height:7mm">
            <div class="hfield-label">${ch('9','Land der endgültigen Bestimmung / Pays de destination définitive / Paese di destinazione definitiva')}</div>
            <div class="hfield-value">${fv(artistCC || '——')}</div>
          </div>
          <div class="cell" style="min-height:8mm">
            ${ch('10','Zweck der vorübergehenden Verwendung / But de l\'admission temporaire / Scopo dell\'ammissione temporanea')}
            ${fv('Verkauf an Ausstellungen / Messen · Vente aux expositions / foires')}
          </div>
          <div class="cell" style="min-height:8mm; border-bottom:none; flex:1">
            <div style="display:flex; gap:4mm; align-items:flex-start">
              <div>
                ${ch('11','Mietgeschäft / Location / Locazione')}
                <div style="margin-top:1mm">
                  <span class="cb"><span class="cb-box"></span> ja / oui / sì</span>
                  <span class="cb"><span class="cb-box"></span> nein / non / no</span>
                </div>
              </div>
              <div style="border-left:0.5px solid #ccc; padding-left:3mm; flex:1">
                ${ch('12','VKZ/MTS · Immat. Land · PLZ/NPA/CAP')}
                <div style="display:flex; gap:2mm; margin-top:1mm; align-items:flex-start">
                  <div class="f12-seg">
                    <div class="f12-lbl">VKZ/MTS</div>
                    <span class="fv">${X(vtsCode)}</span>
                  </div>
                  <div class="f12-seg">
                    <div class="f12-lbl">Immat. Land</div>
                    <span class="fv">${X(field12CC || '______')}</span>
                  </div>
                  <div class="f12-seg" style="border-right:none">
                    <div class="f12-lbl">PLZ/NPA/CAP</div>
                    <span class="fv">${X(field12PLZ)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Goods table: fields 13–14 (description row) -->
      <div class="gt-wrap" style="border-bottom:none">
        <table class="gt">
          <colgroup>
            <col style="width:4mm">
            <col style="width:22mm">
            <col>
          </colgroup>
          <thead><tr>
            <th class="rn"></th>
            <th>13 Zeichen, Nr., Anzahl, Verpackung<br>Marque, no, nombre, emballage<br>Marca, n., quantità imballaggio</th>
            <th>14 Genaue Warenbezeichnung (Material, Typ, Nummern, etc.), die eine Identifikation der Ware erlaubt<br>Désignation exacte de la marchandise permettant son identification<br>Designazione esatta della merce che ne permette l'identificazione</th>
          </tr></thead>
          <tbody>
            <tr class="data-row">
              <td class="rn">1</td>
              <td><span class="gfv">See attached list</span></td>
              <td><span class="gfv">${X(allRetTitles || '—')}</span></td>
            </tr>
            <tr class="data-row">
              <td class="rn">2</td>
              <td></td><td></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Goods table: fields 15–23 (numeric row) -->
      <div class="gt-wrap">
        <table class="gt">
          <colgroup>
            <col style="width:4mm">
            <col style="width:7mm"><col style="width:6mm">
            <col style="width:20mm">
            <col style="width:8mm">
            <col style="width:13mm"><col style="width:13mm">
            <col style="width:13mm"><col style="width:19mm"><col style="width:14mm">
          </colgroup>
          <thead><tr>
            <th class="rn"></th>
            <th>15<br>NHW<br>MNC</th>
            <th>16<br>VC<br>CT</th>
            <th>17 Tarif-Nr.<br>No de tarif<br>Voce di tariffa</th>
            <th>18<br>Schlüssel<br>Clé<br>N.conv.</th>
            <th>19 Eigenmasse<br>Masse nette<br>Massa netta</th>
            <th>20 Zusatz-menge<br>Unités suppl.<br>Unità suppl.</th>
            <th>21 Rohmasse<br>Masse brute<br>Massa lorda</th>
            <th>22 Stat. Wert in CHF<br>Valeur stat. CHF<br>Valore stat. CHF</th>
            <th>23 MWST-Wert<br>Valeur-TVA<br>Valore-IVA</th>
          </tr></thead>
          <tbody>
            <tr class="data-row">
              <td class="rn">1</td>
              <td></td><td></td>
              ${gcell(g1.retQty > 0 && g1.tariffNo !== '—' ? g1.tariffNo : '')}
              <td></td>
              ${gcell(g1.retQty > 0 ? Math.round(g1.retWeightKg) : '')}
              ${gcell(g1.retQty > 0 ? g1.retQty : '', 'center')}
              ${gcell(g1.retQty > 0 ? Math.round(g1.retWeightKg) : '')}
              ${gcell(g1.retQty > 0 ? g1.retValue : '')}
              <td></td>
            </tr>
            ${hasG2 ? `<tr class="data-row">
              <td class="rn">2</td>
              <td></td><td></td>
              ${gcell(g2.retQty > 0 && g2.tariffNo !== '—' ? g2.tariffNo : '')}
              <td></td>
              ${gcell(g2.retQty > 0 ? Math.round(g2.retWeightKg) : '')}
              ${gcell(g2.retQty > 0 ? g2.retQty : '', 'center')}
              ${gcell(g2.retQty > 0 ? Math.round(g2.retWeightKg) : '')}
              ${gcell(g2.retQty > 0 ? g2.retValue : '')}
              <td></td>
            </tr>` : ''}
          </tbody>
        </table>
      </div>

      <!-- Footer: 24 + 25 -->
      <div class="footer">
        <div class="f24">
          ${ch('24','Ort / Datum · Lieu / Date · Luogo / Data')}
          <div style="margin-top:1mm"><span class="fv">${X(eventCity ? eventCity + ', ' : '')}${X(today)}</span></div>
          <div style="margin-top:2mm; font-size:4.8pt; color:#444">Der Anmelder / Le déclarant / Il dichiarante</div>
          <div style="margin-top:0.5mm"><span class="fv">${X(a.fullName || '——')}</span></div>
          <div class="sig-note">→ Recommended: same person who signed the 11.74</div>
          <div class="sig-line">Unterschrift / Signature / Firma</div>
          <div style="margin-top:1mm; font-size:4.5pt; color:#444">Ref. / Réf. / Rif. &nbsp;<span style="border-bottom:0.5px solid #999;display:inline-block;min-width:30mm">&nbsp;</span></div>
        </div>
        <div class="f25">
          ${ch('25','Mehrwertsteuer / Taxe sur la valeur ajoutée / Imposta sul valore aggiunto')}
          <div style="font-size:4.8pt; line-height:2.2; margin-top:1mm; color:#333">
            MWST-Code / Code-TVA / Codice-IVA &nbsp;<span style="border-bottom:0.5px solid #999;display:inline-block;min-width:14mm">&nbsp;</span><br>
            MWST-Register-Nr. / No d'enregistrement-TVA / N. di registrazione IVA<br>
            <span style="border-bottom:0.5px solid #999;display:inline-block;min-width:38mm">&nbsp;</span>
          </div>
        </div>
      </div>

      <!-- Customs verification area -->
      <div class="customs-bar">
        Zollbefund · Résultat de la vérification · Risultato della visita
        <div class="customs-boxes">
          <div class="customs-box">Annahme / Acceptation / Accettazione</div>
          <div class="customs-box">Kontrolle / Contrôle / Controllo</div>
        </div>
      </div>

    </div><!-- fb -->
    <div class="strip strip-r">
      <div class="strip-a">A</div>
    </div>
  </div><!-- body-wrap -->

  <div class="form-footer">Form. 11.87 · 1.2022 · Nachdruck verboten / Reproduction interdite / Riproduzione vietata</div>
</div><!-- page -->
</body></html>`;

  const win = window.open('', '_blank', 'width=960,height=1100');
  if (!win) { showToast('Pop-up blocked - allow pop-ups and try again.', 'error'); return; }
  win.document.write(html);
  win.document.close();
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* =========================================================
   PERMIT OBLIGATION OVERRIDES
   ========================================================= */
function renderPermitOverrides() {
  const soldProducts = state.products.filter(p => {
    if (p.unlisted) return false;
    if (p.variants && p.variants.length > 0)
      return p.variants.some(v => !v.unlisted && (v.soldQty || 0) > 0);
    return (p.soldQty || 0) > 0;
  });
  const section  = document.getElementById('permit-section');
  const list     = document.getElementById('permit-list');
  const hint     = document.getElementById('permit-overrides-hint');
  if (!section || !list) return;

  if (soldProducts.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';

  const overrideCount = soldProducts.filter(p => p.permitOverride != null).length;
  if (hint) {
    hint.textContent = overrideCount > 0
      ? `${overrideCount} override${overrideCount !== 1 ? 's' : ''} from HS-code default`
      : 'defaults from HS code — click a value to override';
  }

  list.innerHTML = soldProducts.map(p => {
    const listedSoldQty = (p.variants && p.variants.length > 0)
      ? p.variants.filter(v => !v.unlisted).reduce((s, v) => s + (v.soldQty || 0), 0)
      : (p.soldQty || 0);
    const defaultVal   = getPermitObligation(p.tariffNo);
    const currentVal   = p.permitOverride != null ? p.permitOverride : defaultVal;
    const isOverridden = p.permitOverride != null && p.permitOverride !== defaultVal;
    const overrideBadge = isOverridden
      ? `<span class="permit-overridden-badge">overridden</span>` : '';
    const cls0 = currentVal === 0 ? 'seg-active-0' : '';
    const cls2 = currentVal === 2 ? 'seg-active-2' : '';
    return `<div class="permit-row">
      <div class="permit-row-info">
        <div class="permit-row-name">${escHtml(p.title || '(untitled)')}</div>
        <div class="permit-row-meta">${listedSoldQty}× sold · HS ${escHtml(p.tariffNo || '—')} · default: ${defaultVal}</div>
      </div>
      ${overrideBadge}
      <div class="permit-seg">
        <button class="permit-seg-btn ${cls0}" onclick="setPermitOverride('${escHtml(p.id)}',0)" title="0 — bewilligungsfrei gemäss Deklarant (permit-free, as stated by declarant)">0</button>
        <button class="permit-seg-btn ${cls2}" onclick="setPermitOverride('${escHtml(p.id)}',2)" title="2 — nicht bewilligungspflichtig (not subject to permit obligation)">2</button>
      </div>
    </div>`;
  }).join('');
}

function setPermitOverride(pid, val) {
  const p = state.products.find(pr => pr.id === pid);
  if (!p) return;
  const defaultVal = getPermitObligation(p.tariffNo);
  // Clicking the already-active value resets to default (clears override)
  if (p.permitOverride != null ? p.permitOverride === val : defaultVal === val) {
    p.permitOverride = null;
  } else {
    p.permitOverride = val;
  }
  saveToStorage();
  renderPermitOverrides();
}

/* =========================================================
   HELPER FUNCTIONS FOR E-DEC
   ========================================================= */
function countryToCode(name) {
  if (!name) return '';
  const trimmed = name.trim();
  if (/^[A-Z]{2}$/.test(trimmed)) return trimmed;
  const code = COUNTRY_CODES[trimmed.toLowerCase()];
  if (code) return code;
  return trimmed.toUpperCase().slice(0, 2);
}

function parsePostCodeCity(str) {
  if (!str) return { postCode: '', city: '' };
  const match = str.match(/^(\S+)\s+(.+)$/);
  if (match) return { postCode: match[1], city: match[2] };
  return { postCode: '', city: str };
}

function toEdecHsCode(code) {
  if (!code) return '';
  // "4911.91.00" → "4911.9100"
  return code.replace(/^(\d{4})\.(\d{2})\.(\d{2})$/, '$1.$2$3');
}

function getPermitObligation(tariffNo) {
  if (!tariffNo) return 0;
  const hsEntry = HS_CODES.find(h => h.code === tariffNo);
  if (hsEntry) return hsEntry.permit || 0;
  if (tariffNo.startsWith('7117')) return 2;
  return 0;
}

function getVatCode(vatRate) {
  if (vatRate != null && parseFloat(vatRate) <= 2.7) return 2;
  return 1;
}

function escapeXml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* =========================================================
   GENERATE E-DEC XML
   ========================================================= */
function generateEdecXML() {
  const soldProducts = state.products.filter(p => {
    if (p.unlisted) return false;
    if (p.variants && p.variants.length > 0)
      return p.variants.some(v => !v.unlisted && (v.soldQty || 0) > 0);
    return (p.soldQty || 0) > 0;
  });

  if (soldProducts.length === 0) {
    showToast('No products have sold quantities > 0. Enter sold quantities first.', 'error');
    return;
  }

  const e = state.edec;
  const a = state.artist;
  const dispatchCountry = countryToCode(a.countryOfOrigin);
  const declarantAddr   = parsePostCodeCity(a.postCodeCity);

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const createdDate = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} `
                    + `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}.000 UTC`;

  const lines = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<EdecWeb version="4.0" createdDate="${escapeXml(createdDate)}">`);
  lines.push(`  <goodsDeclarationType>`);
  lines.push(`    <serviceType>1</serviceType>`);
  lines.push(`    <declarationType>1</declarationType>`);
  lines.push(`    <language>de</language>`);
  lines.push(`    <dispatchCountry>${escapeXml(dispatchCountry)}</dispatchCountry>`);
  const tMode = e.transportMode || '3';
  lines.push(`    <transportMeans>`);
  lines.push(`      <transportMode>${escapeXml(tMode)}</transportMode>`);
  // transportationType (road subtype) is only valid for road transport (mode 3)
  if (tMode === '3') {
    lines.push(`      <transportationType>${escapeXml(e.transportationType || '1')}</transportationType>`);
  }
  lines.push(`      <transportationCountry>${escapeXml((e.transportationCountry || '').toUpperCase())}</transportationCountry>`);
  lines.push(`      <transportationNumber>${escapeXml(e.transportationNumber || '')}</transportationNumber>`);
  lines.push(`    </transportMeans>`);
  lines.push(`    <transportInContainer>0</transportInContainer>`);
  lines.push(`    <previousDocument/>`);

  const m = state.meta;
  const venueCC = countryToCode(m.venueCountry) || 'CH';

  // Importer
  lines.push(`    <importer>`);
  lines.push(`      <name>${escapeXml(m.venueName || '')}</name>`);
  lines.push(`      <addressSupplement1>${escapeXml('c/o ' + (m.event || ''))}</addressSupplement1>`);
  lines.push(`      <addressSupplement2>${escapeXml(m.venueStreet || '')}</addressSupplement2>`);
  lines.push(`      <postalCode>${escapeXml(m.venuePostcode || '')}</postalCode>`);
  lines.push(`      <city>${escapeXml(m.venueCity || '')}</city>`);
  lines.push(`      <country>${escapeXml(venueCC)}</country>`);
  lines.push(`      <traderIdentificationNumber>${escapeXml(m.venueTIN || '')}</traderIdentificationNumber>`);
  lines.push(`    </importer>`);

  // Consignee (same as importer)
  lines.push(`    <consignee>`);
  lines.push(`      <name>${escapeXml(m.venueName || '')}</name>`);
  lines.push(`      <addressSupplement1>${escapeXml('c/o ' + (m.event || ''))}</addressSupplement1>`);
  lines.push(`      <addressSupplement2>${escapeXml(m.venueStreet || '')}</addressSupplement2>`);
  lines.push(`      <postalCode>${escapeXml(m.venuePostcode || '')}</postalCode>`);
  lines.push(`      <city>${escapeXml(m.venueCity || '')}</city>`);
  lines.push(`      <country>${escapeXml(venueCC)}</country>`);
  lines.push(`      <traderIdentificationNumber>${escapeXml(m.venueTIN || '')}</traderIdentificationNumber>`);
  lines.push(`    </consignee>`);

  // Declarant (from artist info)
  lines.push(`    <declarant>`);
  lines.push(`      <traderIdentificationNumber></traderIdentificationNumber>`);
  lines.push(`      <name>${escapeXml(a.fullName || a.companyName || '')}</name>`);
  lines.push(`      <street>${escapeXml(a.street || '')}</street>`);
  lines.push(`      <postalCode>${escapeXml(declarantAddr.postCode)}</postalCode>`);
  lines.push(`      <city>${escapeXml(declarantAddr.city)}</city>`);
  lines.push(`      <country>${escapeXml(dispatchCountry)}</country>`);
  lines.push(`    </declarant>`);

  lines.push(`    <business>`);
  lines.push(`      <customsAccount>0</customsAccount>`);
  lines.push(`      <vatAccount>0</vatAccount>`);
  lines.push(`      <vatSuffix>0</vatSuffix>`);
  lines.push(`      <invoiceCurrencyType>1</invoiceCurrencyType>`);
  lines.push(`    </business>`);

  lines.push(`    <goodsItem>`);

  soldProducts.forEach((p, idx) => {
    // For variant products, aggregate only non-unlisted variants
    const listedVariants = (p.variants && p.variants.length > 0)
      ? p.variants.filter(v => !v.unlisted)
      : null;
    const soldQty  = listedVariants
      ? listedVariants.reduce((s, v) => s + (v.soldQty || 0), 0)
      : (p.soldQty || 0);
    const soldVal  = listedVariants
      ? listedVariants.reduce((s, v) => s + (v.soldValue || 0), 0)
      : (p.soldValue || 0);

    // Round to nearest 100 g (0.1 kg), minimum 0.1 kg
    const weightKg  = Math.max(0.1, Math.round(soldQty * (p.weightG || 0) / 100) / 10);
    const permit    = p.permitOverride != null ? p.permitOverride : getPermitObligation(p.tariffNo);
    const vatCode   = getVatCode(p.vatRate);
    const hsCode    = toEdecHsCode(p.tariffNo);
    const originCc  = (p.originCountry && p.originCountry.trim())
      ? p.originCountry.trim().toUpperCase()
      : dispatchCountry;

    // Statistical value: prefer soldValue if entered, else qty × unit price, else proportional from totalValue
    let statValue = 0;
    if (soldVal > 0) {
      statValue = Math.floor(soldVal);
    } else if (p.price != null && p.price !== '') {
      statValue = Math.floor(soldQty * parseFloat(p.price));
    } else if (p.totalValueCHF != null && p.amount) {
      statValue = Math.floor((soldQty / p.amount) * parseFloat(p.totalValueCHF));
    }

    lines.push(`      <GoodsItemType>`);
    lines.push(`        <traderItemID>${idx}</traderItemID>`);
    lines.push(`        <description>${escapeXml(soldQty + ' ' + (p.title || ''))}</description>`);
    lines.push(`        <commodityCode>${escapeXml(hsCode)}</commodityCode>`);
    lines.push(`        <grossMass>${weightKg}</grossMass>`);
    lines.push(`        <netMass>${weightKg}</netMass>`);
    lines.push(`        <permitObligation>${permit}</permitObligation>`);
    lines.push(`        <nonCustomsLawObligation>${permit}</nonCustomsLawObligation>`);
    lines.push(`        <statistic>`);
    lines.push(`          <customsClearanceType>1</customsClearanceType>`);
    lines.push(`          <commercialGood>1</commercialGood>`);
    lines.push(`          <statisticalValue>${statValue}</statisticalValue>`);
    lines.push(`          <repair>0</repair>`);
    lines.push(`        </statistic>`);
    lines.push(`        <origin>`);
    lines.push(`          <originCountry>${escapeXml(originCc)}</originCountry>`);
    lines.push(`          <preference>0</preference>`);
    lines.push(`        </origin>`);
    const pkgType = p.packagingType || 'CT';
    if (pkgType === 'NE') {
      lines.push(`        <packaging>`);
      lines.push(`          <PackagingType>`);
      lines.push(`            <packagingType>NE</packagingType>`);
      lines.push(`            <quantity>0</quantity>`);
      lines.push(`          </PackagingType>`);
      lines.push(`        </packaging>`);
    } else {
      lines.push(`        <packaging>`);
      lines.push(`          <PackagingType>`);
      lines.push(`            <packagingType>${escapeXml(pkgType)}</packagingType>`);
      lines.push(`            <quantity>1</quantity>`);
      lines.push(`            <packagingReferenceNumber>1</packagingReferenceNumber>`);
      lines.push(`          </PackagingType>`);
      lines.push(`        </packaging>`);
    }
    lines.push(`        <valuation>`);
    lines.push(`          <netDuty>0</netDuty>`);
    lines.push(`          <vatValue>${statValue}</vatValue>`);
    lines.push(`          <vatCode>${vatCode}</vatCode>`);
    lines.push(`        </valuation>`);
    lines.push(`      </GoodsItemType>`);
  });

  lines.push(`    </goodsItem>`);
  lines.push(`  </goodsDeclarationType>`);
  lines.push(`</EdecWeb>`);

  const xmlString = lines.join('\n');

  const eventName = state.meta.event || 'ZollTool';
  const artist    = state.artist.companyName || state.artist.fullName || '';
  const dateStr   = new Date().toISOString().slice(0, 10);
  const filename  = [eventName, artist, 'edec', dateStr]
    .filter(Boolean).join('_')
    .replace(/[^a-zA-Z0-9_\-\.]/g, '_') + '.xml';

  const blob = new Blob([xmlString], { type: 'application/xml' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href     = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { document.body.removeChild(link); URL.revokeObjectURL(url); }, 100);
  showToast('E-dec XML exported: ' + filename, 'success');
}

/* =========================================================
   IMPORT E-DEC XML
   ========================================================= */

/** "4911.9100" → "4911.91.00" */
function fromEdecHsCode(code) {
  if (!code) return '';
  // Remove any trailing spaces
  code = code.trim();
  // Already in ZollTool format "NNNN.NN.NN"?
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(code)) return code;
  // E-dec format "NNNN.NNNN"
  const m = code.match(/^(\d{4})\.(\d{2})(\d{2})$/);
  if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  return code;
}

/** vatCode 1 → 8.1, 2 → 2.6 */
function vatCodeToRate(code) {
  const n = parseInt(code, 10);
  if (n === 2) return 2.6;
  return 8.1;
}

/** Get text content of first matching tag within a parent element */
function xmlText(parent, tag) {
  const el = parent.querySelector(tag);
  return el ? el.textContent.trim() : '';
}

/** Parse "104 Printed Works" → { qty: 104, title: "Printed Works" } */
function parseEdecDescription(desc) {
  if (!desc) return { qty: 0, title: '' };
  const m = desc.match(/^(\d+)\s+(.+)$/);
  if (m) return { qty: parseInt(m[1], 10), title: m[2].trim() };
  return { qty: 0, title: desc.trim() };
}

/** Stored parsed data while the import modal is open */
let _edecImportData = null;

function openEdecImportModal(xmlString, filename) {
  const parser = new DOMParser();
  let doc;
  try {
    doc = parser.parseFromString(xmlString, 'application/xml');
  } catch (e) {
    showToast('Could not parse XML file.', 'error');
    return;
  }
  // Check for parse error
  if (doc.querySelector('parsererror')) {
    showToast('XML parse error — please check the file.', 'error');
    return;
  }

  const gdt = doc.querySelector('goodsDeclarationType');
  if (!gdt) {
    showToast('Not a valid E-dec XML (missing goodsDeclarationType).', 'error');
    return;
  }

  // ── Transport ──────────────────────────────────────────
  const tm = gdt.querySelector('transportMeans');
  const transport = tm ? {
    transportMode:          xmlText(tm, 'transportMode'),
    transportationCountry:  xmlText(tm, 'transportationCountry'),
    transportationNumber:   xmlText(tm, 'transportationNumber'),
    transportationType:     xmlText(tm, 'transportationType'),
  } : null;

  // ── Importer → Venue ───────────────────────────────────
  const imp = gdt.querySelector('importer');
  let venue = null;
  if (imp) {
    const supp1 = xmlText(imp, 'addressSupplement1'); // "c/o EventName"
    const eventName = supp1.startsWith('c/o ') ? supp1.slice(4) : supp1;
    venue = {
      venueName:    xmlText(imp, 'name'),
      venueStreet:  xmlText(imp, 'addressSupplement2'),
      venuePostcode: xmlText(imp, 'postalCode'),
      venueCity:    xmlText(imp, 'city'),
      venueCountry: xmlText(imp, 'country'),
      venueTIN:     xmlText(imp, 'traderIdentificationNumber'),
      eventName,
    };
  }

  // ── Declarant → Artist ────────────────────────────────
  const decl = gdt.querySelector('declarant');
  let artist = null;
  if (decl) {
    const postCode = xmlText(decl, 'postalCode');
    const city     = xmlText(decl, 'city');
    artist = {
      fullName:        xmlText(decl, 'name'),
      street:          xmlText(decl, 'street'),
      postCodeCity:    [postCode, city].filter(Boolean).join(' '),
      countryOfOrigin: xmlText(decl, 'country'),
    };
  }

  // ── Products (GoodsItemType) ───────────────────────────
  const goodsItems = Array.from(gdt.querySelectorAll('GoodsItemType'));
  const products = goodsItems.map(gi => {
    const { qty, title } = parseEdecDescription(xmlText(gi, 'description'));
    const hsCode   = fromEdecHsCode(xmlText(gi, 'commodityCode'));
    const grossMass = parseFloat(xmlText(gi, 'grossMass')) || 0;  // kg
    const vatCode  = xmlText(gi, 'vatCode');
    const statVal  = parseInt(xmlText(gi, 'statisticalValue'), 10) || 0;
    const permit   = parseInt(xmlText(gi, 'permitObligation'), 10);
    const origin   = xmlText(gi, 'originCountry');
    const pkgType  = xmlText(gi, 'packagingType') || 'CT';
    const vatRate  = vatCodeToRate(vatCode);

    // Weight per item in grams
    const weightG = qty > 0 ? Math.round((grossMass * 1000) / qty) : 0;

    // Unit price estimate
    const price = qty > 0 ? Math.round((statVal / qty) * 100) / 100 : 0;

    // Permit override: only set if it differs from the HS-code default
    const defaultPermit = getPermitObligation(hsCode);
    const permitOverride = (Number.isFinite(permit) && permit !== defaultPermit) ? permit : null;

    return {
      title,
      tariffNo:      hsCode,
      amount:        qty,
      soldQty:       qty,
      soldValue:     statVal,
      weightG,
      price,
      totalValueCHF: statVal,
      vatRate,
      originCountry: origin,
      packagingType: pkgType,
      permitOverride,
      _permit:       permit, // raw value for display
    };
  }).filter(p => p.title);

  _edecImportData = { filename, transport, venue, artist, products };
  renderEdecImportModal(_edecImportData);
  document.getElementById('edec-import-overlay').style.display = 'flex';
}

function renderEdecImportModal(data) {
  const body = document.getElementById('edec-import-body');

  const modeLabels = { '1':'Sea','2':'Rail','3':'Road','4':'Air','5':'Post','9':'Own propulsion' };

  let html = `<div class="edec-import-filename">📄 ${escapeXml(data.filename)}</div>`;

  // ── Artist / Declarant ────────────────────────────────
  if (data.artist) {
    const a = data.artist;
    html += `
    <div class="edec-import-section">
      <label class="edec-import-section-label">
        <input type="checkbox" id="edec-imp-artist" checked />
        <span>Artist / Declarant Info</span>
      </label>
      <div class="edec-import-details" id="edec-imp-artist-details">
        <div class="edec-import-row"><span class="edec-import-key">Name</span><span class="edec-import-val">${escapeXml(a.fullName || '—')}</span></div>
        <div class="edec-import-row"><span class="edec-import-key">Street</span><span class="edec-import-val">${escapeXml(a.street || '—')}</span></div>
        <div class="edec-import-row"><span class="edec-import-key">Postcode &amp; City</span><span class="edec-import-val">${escapeXml(a.postCodeCity || '—')}</span></div>
        <div class="edec-import-row"><span class="edec-import-key">Country</span><span class="edec-import-val">${escapeXml(a.countryOfOrigin || '—')}</span></div>
      </div>
    </div>`;
  }

  // ── Venue / Importer ──────────────────────────────────
  if (data.venue) {
    const v = data.venue;
    html += `
    <div class="edec-import-section">
      <label class="edec-import-section-label">
        <input type="checkbox" id="edec-imp-venue" checked />
        <span>Venue / Importer Info</span>
      </label>
      <div class="edec-import-details" id="edec-imp-venue-details">
        ${v.eventName ? `<div class="edec-import-row"><span class="edec-import-key">Event Name</span><span class="edec-import-val">${escapeXml(v.eventName)}</span></div>` : ''}
        <div class="edec-import-row"><span class="edec-import-key">Contact Name</span><span class="edec-import-val">${escapeXml(v.venueName || '—')}</span></div>
        <div class="edec-import-row"><span class="edec-import-key">Street</span><span class="edec-import-val">${escapeXml(v.venueStreet || '—')}</span></div>
        <div class="edec-import-row"><span class="edec-import-key">Postcode</span><span class="edec-import-val">${escapeXml(v.venuePostcode || '—')}</span></div>
        <div class="edec-import-row"><span class="edec-import-key">City</span><span class="edec-import-val">${escapeXml(v.venueCity || '—')}</span></div>
        <div class="edec-import-row"><span class="edec-import-key">Country</span><span class="edec-import-val">${escapeXml(v.venueCountry || '—')}</span></div>
        ${v.venueTIN ? `<div class="edec-import-row"><span class="edec-import-key">UID / TIN</span><span class="edec-import-val">${escapeXml(v.venueTIN)}</span></div>` : ''}
      </div>
    </div>`;
  }

  // ── Transport ─────────────────────────────────────────
  if (data.transport) {
    const t = data.transport;
    const modeLabel = modeLabels[t.transportMode] || t.transportMode;
    html += `
    <div class="edec-import-section">
      <label class="edec-import-section-label">
        <input type="checkbox" id="edec-imp-transport" checked />
        <span>Transport</span>
      </label>
      <div class="edec-import-details" id="edec-imp-transport-details">
        <div class="edec-import-row"><span class="edec-import-key">Mode</span><span class="edec-import-val">${escapeXml(modeLabel)}</span></div>
        <div class="edec-import-row"><span class="edec-import-key">Vehicle Country</span><span class="edec-import-val">${escapeXml(t.transportationCountry || '—')}</span></div>
        <div class="edec-import-row"><span class="edec-import-key">Plate / Number</span><span class="edec-import-val">${escapeXml(t.transportationNumber || '—')}</span></div>
      </div>
    </div>`;
  }

  // ── Products ──────────────────────────────────────────
  if (data.products.length > 0) {
    const cur = (state.meta && state.meta.currency) || 'CHF';
    html += `
    <div class="edec-import-section">
      <label class="edec-import-section-label">
        <input type="checkbox" id="edec-imp-products" checked />
        <span>Products <span class="edec-import-count">${data.products.length} item${data.products.length !== 1 ? 's' : ''}</span></span>
      </label>
      <div class="edec-import-details" id="edec-imp-products-details">
        <div class="edec-import-product-mode">
          <label class="radio-label"><input type="radio" name="edec-imp-mode" value="add" checked /> Add to existing products</label>
          <label class="radio-label"><input type="radio" name="edec-imp-mode" value="replace" /> Replace all products</label>
        </div>
        <div class="edec-import-product-list">
          <div class="edec-import-product-header">
            <span></span>
            <span>Title</span>
            <span>HS Code</span>
            <span>Qty / Sold</span>
            <span>Value (${escapeXml(cur)})</span>
            <span>Permit</span>
          </div>`;

    data.products.forEach((p, i) => {
      const hsEntry = HS_CODES.find(h => h.code === p.tariffNo);
      const hsDesc = hsEntry ? hsEntry.desc : (p.tariffNo || '—');
      html += `
          <div class="edec-import-product-row">
            <input type="checkbox" class="edec-imp-product-cb" data-idx="${i}" checked />
            <span class="edec-import-product-title" title="${escapeXml(hsDesc)}">${escapeXml(p.title)}</span>
            <span class="edec-import-product-hs">${escapeXml(p.tariffNo || '—')}</span>
            <span class="edec-import-product-qty">${p.amount}</span>
            <span class="edec-import-product-val">${p.soldValue.toLocaleString()}</span>
            <span class="edec-import-product-permit permit-chip-${p._permit}">${p._permit}</span>
          </div>`;
    });

    html += `
        </div>
        <p class="edec-import-note">Quantities will be set as both <strong>Amount</strong> and <strong>Sold Qty</strong>. Weight per item is estimated from gross mass.</p>
      </div>
    </div>`;
  } else {
    html += `<p class="edec-import-note" style="margin-top:12px">⚠ No product lines (GoodsItemType) found in this file.</p>`;
  }

  body.innerHTML = html;

  // Toggle details visibility when section checkbox changes
  ['artist', 'venue', 'transport', 'products'].forEach(key => {
    const cb = document.getElementById(`edec-imp-${key}`);
    if (!cb) return;
    cb.addEventListener('change', () => {
      const det = document.getElementById(`edec-imp-${key}-details`);
      if (det) det.style.opacity = cb.checked ? '1' : '0.4';
    });
  });
}

function applyEdecImport() {
  const data = _edecImportData;
  if (!data) return;

  const importArtist    = document.getElementById('edec-imp-artist')?.checked;
  const importVenue     = document.getElementById('edec-imp-venue')?.checked;
  const importTransport = document.getElementById('edec-imp-transport')?.checked;
  const importProducts  = document.getElementById('edec-imp-products')?.checked;
  const replaceProducts = document.querySelector('input[name="edec-imp-mode"][value="replace"]')?.checked;

  let changes = 0;

  // ── Artist ────────────────────────────────────────────
  if (importArtist && data.artist) {
    const a = data.artist;
    if (a.fullName)        { state.artist.fullName        = a.fullName;        changes++; }
    if (a.street)          { state.artist.street          = a.street;          changes++; }
    if (a.postCodeCity)    { state.artist.postCodeCity    = a.postCodeCity;    changes++; }
    if (a.countryOfOrigin) { state.artist.countryOfOrigin = a.countryOfOrigin; changes++; }
    // Sync inputs
    ['fullName','street','postCodeCity','countryOfOrigin'].forEach(k => {
      const el = document.querySelector(`[data-key="artist.${k}"]`);
      if (el && state.artist[k]) el.value = state.artist[k];
    });
  }

  // ── Venue ─────────────────────────────────────────────
  if (importVenue && data.venue) {
    const v = data.venue;
    if (v.eventName)    { state.meta.event        = v.eventName;    changes++; }
    if (v.venueName)    { state.meta.venueName    = v.venueName;    changes++; }
    if (v.venueStreet)  { state.meta.venueStreet  = v.venueStreet;  changes++; }
    if (v.venuePostcode){ state.meta.venuePostcode = v.venuePostcode; changes++; }
    if (v.venueCity)    { state.meta.venueCity    = v.venueCity;    changes++; }
    if (v.venueCountry) { state.meta.venueCountry = v.venueCountry; changes++; }
    if (v.venueTIN)     { state.meta.venueTIN     = v.venueTIN;     changes++; }
    // Sync inputs
    const metaMap = {
      'event': 'meta.event', 'venueName': 'meta.venueName', 'venueStreet': 'meta.venueStreet',
      'venuePostcode': 'meta.venuePostcode', 'venueCity': 'meta.venueCity',
      'venueCountry': 'meta.venueCountry', 'venueTIN': 'meta.venueTIN',
    };
    Object.entries(metaMap).forEach(([stateKey, dataKey]) => {
      const el = document.querySelector(`[data-key="${dataKey}"]`);
      if (el && state.meta[stateKey]) el.value = state.meta[stateKey];
    });
  }

  // ── Transport ─────────────────────────────────────────
  if (importTransport && data.transport) {
    const t = data.transport;
    if (t.transportMode)         { state.edec.transportMode         = t.transportMode;         changes++; }
    if (t.transportationCountry) { state.edec.transportationCountry = t.transportationCountry; changes++; }
    if (t.transportationNumber)  { state.edec.transportationNumber  = t.transportationNumber;  changes++; }
    if (t.transportationType)    { state.edec.transportationType    = t.transportationType;    changes++; }
    // Sync inputs
    const modeEl = document.getElementById('edec-mode');
    if (modeEl && t.transportMode) modeEl.value = t.transportMode;
    const countryEl = document.getElementById('edec-transport-country');
    if (countryEl && t.transportationCountry) countryEl.value = t.transportationCountry;
    const numEl = document.getElementById('edec-transport-number');
    if (numEl && t.transportationNumber) numEl.value = t.transportationNumber;
  }

  // ── Products ──────────────────────────────────────────
  if (importProducts && data.products.length > 0) {
    const selectedIdxs = Array.from(
      document.querySelectorAll('.edec-imp-product-cb:checked')
    ).map(cb => parseInt(cb.dataset.idx, 10));

    const selectedProducts = selectedIdxs
      .map(i => data.products[i])
      .filter(Boolean);

    if (selectedProducts.length > 0) {
      if (replaceProducts) {
        state.products = [];
      }
      // Batch-insert: push directly to avoid N×renderTable calls
      selectedProducts.forEach(p => {
        state.products.push(Object.assign({
          id:            uuid(),
          title:         '',
          sku:           '',
          forSale:       true,
          type:          '',
          amount:        0,
          weightG:       0,
          price:         null,
          priceNote:     '',
          totalValueCHF: null,
          tariffNo:      '',
          tariffRate:    null,
          vatRate:       null,
          packagingType: 'CT',
          soldQty:       0,
          soldValue:     0,
          soldVAT:       0,
        }, {
          title:          p.title,
          tariffNo:       p.tariffNo,
          amount:         p.amount,
          soldQty:        p.soldQty,
          soldValue:      p.soldValue,
          weightG:        p.weightG,
          price:          p.price || null,
          totalValueCHF:  p.totalValueCHF || null,
          vatRate:        p.vatRate,
          originCountry:  p.originCountry,
          packagingType:  p.packagingType || 'CT',
          permitOverride: p.permitOverride,
          forSale:        true,
        }));
      });
      changes += selectedProducts.length;
    }
  }

  closeEdecImportModal();
  saveToStorage();
  updateSectionSummaries();
  renderTable();

  if (changes > 0) {
    showToast(`Imported successfully (${changes} item${changes !== 1 ? 's' : ''} updated)`, 'success');
  } else {
    showToast('Nothing was imported — no sections were selected.', 'info');
  }
}

function closeEdecImportModal() {
  document.getElementById('edec-import-overlay').style.display = 'none';
  _edecImportData = null;
}

/* =========================================================
   TOAST NOTIFICATIONS
   ========================================================= */
let toastTimer = null;

function showToast(message, type) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = 'toast' + (type ? ' ' + type : '');
  // Force reflow
  toast.offsetHeight; // eslint-disable-line no-unused-expressions
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2800);
}

/* =========================================================
   KEYBOARD SHORTCUTS
   ========================================================= */
document.addEventListener('keydown', (e) => {
  // ESC closes modal
  if (e.key === 'Escape') {
    const overlay = document.getElementById('modal-overlay');
    if (overlay && overlay.style.display !== 'none') {
      hideModal();
    }
  }
});

/* =========================================================
   DRAG AND DROP REORDERING + MERGE
   ========================================================= */
function commonWordPrefix(a, b) {
  const wa = a.trim().split(/\s+/);
  const wb = b.trim().split(/\s+/);
  const shared = [];
  for (let i = 0; i < Math.min(wa.length, wb.length); i++) {
    if (wa[i].toLowerCase() === wb[i].toLowerCase()) shared.push(wa[i]);
    else break;
  }
  return shared.join(' ');
}

function variantSuffix(title, prefix) {
  const s = prefix ? title.slice(prefix.length).trim() : title.trim();
  return s || title.trim();
}

function mergeProductsAsVariants(srcId, tgtId) {
  const srcIdx = state.products.findIndex(p => p.id === srcId);
  const tgtIdx = state.products.findIndex(p => p.id === tgtId);
  if (srcIdx === -1 || tgtIdx === -1) return;
  const src = state.products[srcIdx];
  const tgt = state.products[tgtIdx];

  const srcHas = hasVariants(src);
  const tgtHas = hasVariants(tgt);

  function makeVariantFrom(p, name) {
    return {
      id: 'v' + Date.now() + Math.random().toString(36).slice(2, 6),
      name,
      sku: p.sku || '',
      amount: p.amount || 0,
      soldQty: p.soldQty || 0,
      soldValue: p.soldValue || 0,
      price: p.price,
      weightG: p.weightG
    };
  }

  if (tgtHas && !srcHas) {
    // Drop plain onto variant product — add src as new variant
    const prefix = commonWordPrefix(tgt.title, src.title);
    const varName = variantSuffix(src.title, prefix) || src.title;
    const newVar = makeVariantFrom(src, varName);
    tgt.variants.push(newVar);
    state.products.splice(srcIdx, 1);
  } else if (srcHas && !tgtHas) {
    // Drop variant product onto plain — absorb tgt into src as a variant
    const prefix = commonWordPrefix(src.title, tgt.title);
    const varName = variantSuffix(tgt.title, prefix) || tgt.title;
    const newVar = makeVariantFrom(tgt, varName);
    src.variants.push(newVar);
    state.products.splice(tgtIdx, 1);
  } else if (!srcHas && !tgtHas) {
    // Both plain — create new merged product with two variants
    const prefix = commonWordPrefix(tgt.title, src.title);
    const parentTitle = prefix || tgt.title;
    const tgtName = variantSuffix(tgt.title, prefix) || tgt.title;
    const srcName = variantSuffix(src.title, prefix) || src.title;

    // Use tgt price/weight as parent base; override per variant if they differ
    const pricesDiffer = src.price !== tgt.price;
    const weightsDiffer = src.weightG !== tgt.weightG;

    const merged = {
      ...tgt,
      title: parentTitle,
      sku: '',
      amount: 0,
      soldQty: 0,
      soldValue: 0,
      soldVAT: 0,
      variants: [
        {
          id: 'v' + Date.now() + Math.random().toString(36).slice(2, 6),
          name: tgtName,
          sku: tgt.sku || '',
          amount: tgt.amount || 0,
          soldQty: tgt.soldQty || 0,
          soldValue: tgt.soldValue || 0,
          price: pricesDiffer ? tgt.price : null,
          weightG: weightsDiffer ? tgt.weightG : null
        },
        {
          id: 'v' + (Date.now() + 1) + Math.random().toString(36).slice(2, 6),
          name: srcName,
          sku: src.sku || '',
          amount: src.amount || 0,
          soldQty: src.soldQty || 0,
          soldValue: src.soldValue || 0,
          price: pricesDiffer ? src.price : null,
          weightG: weightsDiffer ? src.weightG : null
        }
      ]
    };
    // Replace tgt in place, remove src
    state.products[tgtIdx] = merged;
    state.products.splice(srcIdx, 1);
  } else {
    // Both have variants — merge src variants into tgt
    for (const v of src.variants) {
      tgt.variants.push({ ...v, id: 'v' + Date.now() + Math.random().toString(36).slice(2, 6) });
    }
    state.products.splice(srcIdx, 1);
  }

  saveToStorage();
  renderTable();
}

function initDragDrop() {
  const tbody = document.getElementById('products-tbody');
  let dragSrcId = null;
  let dragMode = 'reorder'; // 'reorder' | 'merge'

  function clearDragStyles() {
    tbody.querySelectorAll('tr[data-drag]').forEach(r => delete r.dataset.drag);
    tbody.querySelectorAll('tr.drag-over').forEach(r => r.classList.remove('drag-over'));
  }

  tbody.addEventListener('dragstart', e => {
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    // Drag from the ⋮ handle = reorder; drag from anywhere else = merge
    dragMode = e.target.closest('.drag-handle') ? 'reorder' : 'merge';
    dragSrcId = row.dataset.id;
    setTimeout(() => row.classList.add('dragging'), 0);
    e.dataTransfer.effectAllowed = 'copyMove';
  });

  tbody.addEventListener('dragover', e => {
    e.preventDefault();
    const row = e.target.closest('tr[data-id]');
    if (!row || row.dataset.id === dragSrcId) { clearDragStyles(); return; }
    clearDragStyles();
    row.dataset.drag = dragMode;
    e.dataTransfer.dropEffect = dragMode === 'merge' ? 'copy' : 'move';
  });

  tbody.addEventListener('drop', e => {
    e.preventDefault();
    const row = e.target.closest('tr[data-id]');
    const targetId = row ? row.dataset.id : null;
    clearDragStyles();
    if (!dragSrcId || !targetId || dragSrcId === targetId) return;

    if (dragMode === 'merge') {
      mergeProductsAsVariants(dragSrcId, targetId);
    } else {
      const srcIdx = state.products.findIndex(p => p.id === dragSrcId);
      const tgtIdx = state.products.findIndex(p => p.id === targetId);
      const [moved] = state.products.splice(srcIdx, 1);
      state.products.splice(tgtIdx, 0, moved);
      saveToStorage();
      renderTable();
    }
  });

  tbody.addEventListener('dragend', () => {
    clearDragStyles();
    tbody.querySelectorAll('tr').forEach(r => r.classList.remove('dragging'));
    dragSrcId = null;
    dragMode = 'reorder';
  });
}

function openBulkInventory() {
  renderBulkInventory();
  document.getElementById('bulk-overlay').style.display = 'flex';
}

function closeBulkInventory() {
  document.getElementById('bulk-overlay').style.display = 'none';
}

function renderBulkInventory() {
  const tbody = document.getElementById('bulk-tbody');
  if (!tbody) return;
  const rows = [];
  for (const p of state.products) {
    if (hasVariants(p)) {
      for (const v of p.variants) {
        const sold = v.soldQty || 0;
        rows.push(`
          <tr data-product-id="${p.id}" data-variant-id="${v.id}">
            <td class="bulk-variant-label">${escHtml(p.title || '')} - ${escHtml(v.name || '')}</td>
            <td>${escHtml(v.sku || p.sku || '-')}</td>
            <td>${escHtml(p.type || '-')}</td>
            <td><input class="bulk-stock-input bulk-amount" type="number" min="0" step="1" value="${v.amount || 0}" /></td>
            <td><input class="bulk-stock-input bulk-sold" type="number" min="0" step="1" value="${sold}" /></td>
            <td>${Math.max(0, (v.amount || 0) - sold)}</td>
          </tr>`);
      }
    } else {
      const sold = p.soldQty || 0;
      rows.push(`
        <tr data-product-id="${p.id}">
          <td>${escHtml(p.title || '')}</td>
          <td>${escHtml(p.sku || '-')}</td>
          <td>${escHtml(p.type || '-')}</td>
          <td><input class="bulk-stock-input bulk-amount" type="number" min="0" step="1" value="${p.amount || 0}" /></td>
          <td><input class="bulk-stock-input bulk-sold" type="number" min="0" step="1" value="${sold}" /></td>
          <td>${Math.max(0, (p.amount || 0) - sold)}</td>
        </tr>`);
    }
  }
  tbody.innerHTML = rows.join('') || '<tr><td colspan="6">No products yet.</td></tr>';
}

function saveBulkInventory() {
  document.querySelectorAll('#bulk-tbody tr[data-product-id]').forEach(row => {
    const p = state.products.find(pr => pr.id === row.dataset.productId);
    if (!p) return;
    const amount = Math.max(0, parseInt(row.querySelector('.bulk-amount').value, 10) || 0);
    const sold = Math.max(0, parseInt(row.querySelector('.bulk-sold').value, 10) || 0);
    if (row.dataset.variantId) {
      const v = (p.variants || []).find(vv => vv.id === row.dataset.variantId);
      if (!v) return;
      v.amount = amount;
      v.soldQty = sold;
      const price = variantPrice(p, v);
      if (price != null) v.soldValue = sold * price;
    } else {
      p.amount = amount;
      p.soldQty = sold;
      const price = calcProduct(p).effectiveUnitPrice;
      if (price != null) p.soldValue = sold * price;
    }
  });
  saveToStorage();
  renderTable();
  closeBulkInventory();
  showToast('Stock updated.', 'success');
}

/* =========================================================
   INIT
   ========================================================= */
function init() {
  loadFromStorage();

  initCollapsibles();
  bindFormFields();
  updateSectionSummaries();
  renderTable();
  initHsCombobox();

  // Drag-and-drop reordering
  initDragDrop();


  render1174GroupUI();
  init1174GroupUI();

  // Country pickers for persistent fields
  initCountryPicker(document.getElementById('artist-country'), { showName: true });
  initCountryPicker(document.getElementById('venue-country'), { showName: true });
  initCountryPicker(document.getElementById('edec-transport-country'));

  // Show vehicle country + plate only for Road (mode 3); flight number only for Air (mode 4)
  const transportModeEl    = document.getElementById('edec-mode');
  const transportVehicleFields = [
    document.getElementById('edec-transport-country'),
    document.getElementById('edec-transport-number'),
  ].map(el => el && el.closest('.form-group')).filter(Boolean);
  const flightNumberGroup = document.getElementById('flight-number-group');

  function syncTransportFields() {
    const isRoad = transportModeEl.value === '3';
    const isAir  = transportModeEl.value === '4';
    transportVehicleFields.forEach(fg => { fg.style.display = isRoad ? '' : 'none'; });
    if (flightNumberGroup) flightNumberGroup.style.display = isAir ? '' : 'none';
  }

  transportModeEl.addEventListener('change', syncTransportFields);
  // Re-check when vehicle country or artist country changes
  const transportCountryEl = document.getElementById('edec-transport-country');
  syncTransportFields();

  // Modal country picker (modal DOM always present)
  initCountryPicker(document.getElementById('m-origin'));

  // Venue contact mirrors artist full name unless the user has overridden it
  function syncVenueContact() {
    const artistName  = state.artist.fullName || '';
    const venueEl     = document.getElementById('venue-contact');
    if (!venueEl) return;
    // Only sync when the field is blank or still matches the artist name
    if (!state.meta.venueName || state.meta.venueName === artistName) {
      state.meta.venueName = artistName;
      venueEl.value = artistName;
    }
  }
  syncVenueContact(); // apply on load
  const artistNameEl = document.getElementById('artist-name');
  if (artistNameEl) artistNameEl.addEventListener('input', syncVenueContact);

  // Header buttons
  document.getElementById('btn-save-json').addEventListener('click', saveJSON);
  document.getElementById('btn-load-json').addEventListener('click', loadJSON);
  document.getElementById('file-input').addEventListener('change', handleFileLoad);

  // Flatpickr date pickers
  if (typeof flatpickr !== 'undefined') {
    fpStart = flatpickr('#event-date-start', {
      dateFormat: 'Y-m-d',
      defaultDate: state.meta.eventDateStart || null,
      onChange: (_, dateStr) => {
        state.meta.eventDateStart = dateStr || '';
        saveToStorage();
        updateSectionSummaries();
        autoGenerateLRP();
      },
    });
    fpEnd = flatpickr('#event-date-end', {
      dateFormat: 'Y-m-d',
      defaultDate: state.meta.eventDateEnd || null,
      onChange: (_, dateStr) => {
        state.meta.eventDateEnd = dateStr || '';
        saveToStorage();
        updateSectionSummaries();
      },
    });
  }

  // Doc-number select -triggers LRP re-generation
  const docNumEl = document.getElementById('doc-number');
  if (state.meta.documentNumber) docNumEl.value = String(state.meta.documentNumber);
  docNumEl.addEventListener('change', (e) => {
    state.meta.documentNumber = parseInt(e.target.value, 10) || 1;
    saveToStorage();
    autoGenerateLRP();
  });

  // Company code + artist country trigger LRP re-generation
  ['company-code', 'artist-country'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', autoGenerateLRP);
  });

  // Update origin cells live when artist country changes
  document.getElementById('artist-country').addEventListener('change', () => {
    const defaultOrigin = countryToCode(state.artist.countryOfOrigin) || '—';
    document.querySelectorAll('#products-tbody tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      const p = state.products.find(pr => pr.id === id);
      if (p && !p.originCountry) {
        const cell = tr.querySelector('.col-origin');
        if (cell) cell.textContent = defaultOrigin;
      }
    });
  });

  // Initial LRP generation
  autoGenerateLRP();

  // Export buttons -each passes its own doc number
  document.getElementById('btn-proforma').addEventListener('click', printProformaInvoice);
  document.getElementById('btn-export-import').addEventListener('click', () => showDocumentFormatDialog(1));
  document.getElementById('btn-export-sold').addEventListener('click',   () => showDocumentFormatDialog(2));
  document.getElementById('btn-export-return').addEventListener('click', () => showDocumentFormatDialog(3));
  document.getElementById('btn-print-1174').addEventListener('click', () => showFormFormatDialog('Form 11.74 — Import (Temporary Admission)', print1174, 1));
  document.getElementById('btn-print-1187').addEventListener('click', () => showFormFormatDialog('Form 11.87 — Re-export (Closure)', print1187, 3));

  // Add product button
  document.getElementById('btn-add-product').addEventListener('click', openAddModal);
  document.getElementById('btn-bulk-inventory').addEventListener('click', openBulkInventory);
  document.getElementById('bulk-close').addEventListener('click', closeBulkInventory);
  document.getElementById('bulk-cancel').addEventListener('click', closeBulkInventory);
  document.getElementById('bulk-save').addEventListener('click', saveBulkInventory);
  document.getElementById('bulk-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('bulk-overlay')) closeBulkInventory();
  });

  // E-dec XML generation
  document.getElementById('btn-generate-edec').addEventListener('click', generateEdecXML);

  // E-dec XML import
  document.getElementById('btn-import-edec').addEventListener('click', () => {
    document.getElementById('edec-import-file').value = '';
    document.getElementById('edec-import-file').click();
  });
  document.getElementById('edec-import-file').addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => openEdecImportModal(e.target.result, file.name);
    reader.readAsText(file, 'UTF-8');
  });
  document.getElementById('edec-import-close').addEventListener('click', closeEdecImportModal);
  document.getElementById('edec-import-cancel').addEventListener('click', closeEdecImportModal);
  document.getElementById('edec-import-confirm').addEventListener('click', applyEdecImport);
  document.getElementById('edec-import-overlay').addEventListener('click', function (e) {
    if (e.target === this) closeEdecImportModal();
  });

  // Modal controls
  document.getElementById('modal-close').addEventListener('click', hideModal);
  document.getElementById('modal-cancel').addEventListener('click', hideModal);
  document.getElementById('modal-save').addEventListener('click', saveModal);

  // Close modal on overlay click
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) {
      hideModal();
    }
  });

  // Live preview inputs in modal
  ['m-amount', 'm-weight', 'm-price', 'm-pricenote', 'm-totalweight', 'm-totalvalue'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateModalPreview);
  });

  // Bidirectional weight sync
  document.getElementById('m-weight').addEventListener('input', () => { syncWeightFromPerItem(); updateModalPreview(); });
  document.getElementById('m-totalweight').addEventListener('input', () => { syncWeightFromTotal(); updateModalPreview(); });
  document.getElementById('m-amount').addEventListener('input', () => { syncWeightFromPerItem(); syncValueFromPerItem(); updateModalPreview(); });

  // Bidirectional value sync
  document.getElementById('m-price').addEventListener('input', () => { syncValueFromPerItem(); updateModalPreview(); });
  document.getElementById('m-totalvalue').addEventListener('input', () => { syncValueFromTotal(); updateModalPreview(); });

  // VAT hint update when VAT rate manually changed
  document.getElementById('m-vatrate').addEventListener('input', updateVatHint);

  // Dark theme toggle -dark is the default unless user has explicitly chosen light
  const themeCb = document.getElementById('theme-toggle-cb');
  const savedTheme = localStorage.getItem('zolltool_theme');
  if (savedTheme !== 'light') {
    document.documentElement.setAttribute('data-theme', 'dark');
    themeCb.checked = true;
  }
  themeCb.addEventListener('change', () => {
    if (themeCb.checked) {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('zolltool_theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('zolltool_theme', 'light');
    }
  });
}

/* =========================================================
   EVENT PRESETS (events.json)
   ========================================================= */
let eventPresets = [];

async function loadEventPresets() {
  const sel = document.getElementById('event-selector');
  if (!sel) return;

  try {
    const res = await fetch('events.json');
    if (!res.ok) throw new Error(res.status);
    eventPresets = await res.json();
  } catch {
    // Fallback for local file:// access -reads events.js if loaded
    eventPresets = window.ZOLLTOOL_EVENTS || [];
  }

  if (eventPresets.length === 0) {
    document.getElementById('event-selector-group').style.display = 'none';
    return;
  }

  eventPresets.forEach(ev => {
    const opt = document.createElement('option');
    opt.value = ev.id;
    opt.textContent = ev.name;
    sel.appendChild(opt);
  });

  sel.addEventListener('change', () => {
    const ev = eventPresets.find(e => e.id === sel.value);
    if (!ev) return;

    const metaMap = {
      name:          'event',
      dateStart:     'eventDateStart',
      dateEnd:       'eventDateEnd',
      venueName:     'venueName',
      venueStreet:   'venueStreet',
      venuePostcode: 'venuePostcode',
      venueCity:     'venueCity',
      venueCountry:  'venueCountry',
      venueTIN:      'venueTIN',
      currency:      'currency',
    };

    Object.entries(metaMap).forEach(([jsonKey, stateKey]) => {
      if (ev[jsonKey] != null) state.meta[stateKey] = ev[jsonKey];
    });

    syncFormFields();
    updateSectionSummaries();
    saveToStorage();
    renderTable();
    renderTotals();
    showToast('Event preset applied: ' + ev.name, 'success');
  });
}

/* =========================================================
   DISCLAIMER MODAL
   ========================================================= */
const DISCLAIMER_KEY = 'zolltool_disclaimer_accepted';

function initDisclaimer() {
  const overlay = document.getElementById('disclaimer-overlay');
  const acceptBtn = document.getElementById('disclaimer-accept');
  const skipCb = document.getElementById('disclaimer-skip-cb');

  if (!overlay || !acceptBtn) return;

  if (localStorage.getItem(DISCLAIMER_KEY) !== '1') {
    overlay.style.display = 'flex';
  }

  acceptBtn.addEventListener('click', () => {
    if (skipCb && skipCb.checked) {
      localStorage.setItem(DISCLAIMER_KEY, '1');
    }
    overlay.style.display = 'none';
  });
}

/* =========================================================
   IFRAME HEIGHT BRIDGE
   Notifies a parent page (e.g. Shopify) of the document's full
   scroll height so the iframe can be resized to fit without its
   own scrollbar appearing.
   ========================================================= */
function initHeightBridge() {
  if (window.parent === window) return; // not inside an iframe
  function postHeight() {
    window.parent.postMessage(
      { type: 'zolltool-height', height: document.documentElement.scrollHeight },
      '*'
    );
  }
  // Fire on any size change (collapsibles opening, products added, etc.)
  new ResizeObserver(postHeight).observe(document.body);
  postHeight();
}

document.addEventListener('DOMContentLoaded', () => { init(); initDisclaimer(); initHeightBridge(); loadEventPresets(); });

// Sync sold quantities if POS updates localStorage from another tab
window.addEventListener('storage', e => {
  if (e.key !== STORAGE_KEY) return;
  loadFromStorage();
  renderTable();
  renderTotals();
});
