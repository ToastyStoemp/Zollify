import { COUNTRY_BY_CODE } from './countries';
import { EU_COUNTRIES, countryCodeOf } from './vat';

/**
 * The legal setup checklist: what a business has to have in place before it
 * sells in a country, worked out from what the account already has. Pure
 * rules over a bag of facts the app gathers; the Settings → Legal setup
 * panel renders them and lets the owner tick off what Zollify cannot see
 * (a filing with a tax office, a signed agreement).
 *
 * Not legal advice. Each step says where the rule comes from; the compliance
 * notes under docs/ carry the detail and the sources.
 */

export type LegalStatus =
  /** Zollify can see it is in place. */
  | 'done'
  /** Zollify can see it is missing, and knows where it is set. */
  | 'todo'
  /** Happens outside Zollify - the owner confirms it; `confirmedOn` holds the date. */
  | 'manual'
  /** Zollify cannot meet the rule; selling that way needs another tool or an exemption. */
  | 'blocked'
  /** Nothing to do: how Zollify already behaves, worth knowing. */
  | 'info';

export interface LegalStep {
  /** Stable, for acknowledgements: `<country>.<step>`. */
  id: string;
  title: string;
  /** One or two sentences: what the rule asks and how Zollify meets it, or what to do. */
  text: string;
  status: LegalStatus;
  /** Where to do it: a settings panel id (`core.vat`, `pos.payments`), or an in-app path (`/m/consignment`). */
  panel?: string;
  path?: string;
  /** A doc under docs/ with the detail. */
  doc?: string;
  /** The rule's source, short. */
  law?: string;
  /** For manual steps: when the owner confirmed it, YYYY-MM-DD. */
  confirmedOn?: string;
}

export interface CountryChecklist {
  code: string;
  name: string;
  /** Why this country is on the list. */
  reason: 'home' | 'events' | 'stores';
  steps: LegalStep[];
  /** Short verdict for the country header. */
  summary: string;
}

/** What the app knows, gathered by the panel. Every field optional: a fact it could not load counts as unknown, never as done. */
export interface LegalFacts {
  /** The business profile's country, name and address. */
  homeCountry: string;
  businessName: string;
  address: string;
  vatId: string;
  enterpriseNumber?: string;
  /** VAT settings: countries where the business is exempt, and the EU EX number. */
  exemptCountries: string[];
  exNumber: string;
  /** Imprint and privacy pages of the business's own site, when set. */
  imprintUrl?: string;
  privacyUrl?: string;
  /** Countries of the events and stores (ISO codes or names), open ones only. */
  eventCountries: string[];
  storeCountries: string[];
  /** Modules switched on for the account. */
  modules: string[];
  /** Germany: the KassenSichV switch, the TSE on this device or through a main device, whether it is certified. */
  kassensichv?: boolean;
  tseMode?: 'own' | 'remote' | 'none';
  tseCertified?: boolean | null;
  tseError?: string | null;
  /** Any closing made yet - shows the day-closing routine has started. */
  closings?: number;
  /** e-conomic connection, when the module is on. */
  economic?: { server: boolean; grant: boolean };
  /** Consignors, when the consignment module is on. */
  consignors?: { name: string; selfBillingAgreedOn: string | null; vatRegistered: boolean; vatId: string }[];
  /** Custom payment method names on this device's till. */
  customMethods?: string[];
  /** Manual steps the owner confirmed: step id → date. */
  confirmed: Record<string, string>;
}

const code = (c: string): string => countryCodeOf(c) || c.trim().toUpperCase();
const name = (c: string): string => COUNTRY_BY_CODE[c] ?? c;

/** The countries a business sells in, home first, each once, with why it is on the list. */
export function countriesInPlay(f: Pick<LegalFacts, 'homeCountry' | 'eventCountries' | 'storeCountries'>): { code: string; reason: CountryChecklist['reason'] }[] {
  const out = new Map<string, CountryChecklist['reason']>();
  const home = code(f.homeCountry);
  if (/^[A-Z]{2}$/.test(home)) out.set(home, 'home');
  for (const c of f.storeCountries.map(code)) if (/^[A-Z]{2}$/.test(c) && !out.has(c)) out.set(c, 'stores');
  for (const c of f.eventCountries.map(code)) if (/^[A-Z]{2}$/.test(c) && !out.has(c)) out.set(c, 'events');
  return [...out].map(([c, reason]) => ({ code: c, reason }));
}

function manual(f: LegalFacts, step: Omit<LegalStep, 'status' | 'confirmedOn'>): LegalStep {
  const on = f.confirmed[step.id];
  return { ...step, status: 'manual', ...(on ? { confirmedOn: on } : {}) };
}

/** Steps every business has, whatever the country. */
function commonSteps(f: LegalFacts, c: string): LegalStep[] {
  const profileDone = Boolean(f.businessName.trim() && f.address.trim() && f.homeCountry.trim());
  const exempt = f.exemptCountries.map(code).includes(c);
  const eu = EU_COUNTRIES.includes(c);
  const home = code(f.homeCountry) === c;
  const vatDone = exempt || Boolean(f.vatId.trim());
  const steps: LegalStep[] = [
    {
      id: `${c}.profile`,
      title: 'Business name and address on every receipt',
      text: profileDone
        ? 'Your receipts, online receipts and public pages name the business and its address from the profile.'
        : 'Receipts must say who sold. Fill in the business name and address under Business profile.',
      status: profileDone ? 'done' : 'todo',
      panel: 'core.profile',
      law: 'Invoice rules of every EU country; § 14 UStG, momsbekendtgørelsen § 58',
    },
    {
      id: `${c}.vat`,
      title: exempt ? `Small-business exemption in ${name(c)}` : `VAT in ${name(c)}`,
      text: exempt
        ? home
          ? 'Receipts carry the exemption note instead of VAT. Check the turnover limit each year.'
          : f.exNumber.trim()
            ? `Exempt under the EU SME scheme: receipts in ${name(c)} show your EX number and the exemption note.`
            : `You marked ${name(c)} as exempt, but the EU SME scheme needs an EX number on receipts outside your home country - add it under VAT.`
        : f.vatId.trim()
          ? `Sales in ${name(c)} charge its VAT rates per product; receipts show your VAT number and the VAT per rate.`
          : `Either charge VAT (enter your VAT number under Business profile) or, if you qualify, mark ${name(c)} as exempt under VAT.`,
      status: exempt ? (home || f.exNumber.trim() ? 'done' : 'todo') : vatDone ? 'done' : 'todo',
      panel: exempt && !home && !f.exNumber.trim() ? 'core.vat' : vatDone ? 'core.vat' : 'core.profile',
      law: eu ? 'EU VAT directive; SME scheme from 2025' : 'National VAT law',
    },
    {
      id: `${c}.numbers`,
      title: 'Receipt numbers without gaps',
      text: 'Every receipt - sales, cancellations and cash movements - is numbered per till in one unbroken series. Nothing to set.',
      status: 'info',
    },
    {
      id: `${c}.records`,
      title: 'Records kept unchanged',
      text: 'Sales are never edited or deleted; a refund is a new entry pointing to the sale. Keep the account (and a backup) for your country’s retention period: 10 years in Germany, 5 in Denmark, 7 in Belgium and the Netherlands, 10 in Switzerland.',
      status: 'info',
      panel: 'core.data',
    },
  ];
  if (home) {
    steps.push({
      id: `${c}.legal-pages`,
      title: 'Imprint and privacy notice on your public pages',
      text:
        f.imprintUrl || f.privacyUrl
          ? 'Your online receipts and events page carry the imprint and privacy block, linking to your own pages.'
          : 'Your online receipts and events page carry a built-in imprint (name, address, VAT number) and privacy notice. If your website has its own imprint and privacy policy, link them under Business profile → Webstore and socials.',
      status: f.imprintUrl || f.privacyUrl ? 'done' : 'info',
      panel: 'core.profile',
      law: 'GDPR Art. 13; § 5 DDG (Germany)',
    });
  }
  return steps;
}

function germany(f: LegalFacts, c: string): LegalStep[] {
  const on = f.kassensichv === true;
  const signs = f.tseMode === 'own' || f.tseMode === 'remote';
  const certified = f.tseCertified === true;
  return [
    {
      id: 'DE.switch',
      title: 'Switch on Germany (KassenSichV)',
      text: on ? 'On: the TSE, closing-the-day and tax export screens are shown.' : 'Settings → Modules → Built in → Germany (KassenSichV). It shows the TSE settings, the day closing and the tax export.',
      status: on ? 'done' : 'todo',
      panel: 'core.modules',
      law: '§ 146a AO, KassenSichV',
      doc: 'germany-compliance.md',
    },
    {
      id: 'DE.tse',
      title: 'A certified TSE signs every sale',
      text: !signs
        ? 'No TSE yet. Set up the fiskaly cloud TSE (Settings → TSE (fiskaly cloud)), then pick it on each device under This device → TSE - or make one device the main TSE device for the others.'
        : certified
          ? 'A certified TSE signs this device’s sales, directly or through a main TSE device.'
          : f.tseError
            ? `The TSE is set but not answering: ${f.tseError}`
            : 'A TSE is set, but it is a test TSE or fiskaly’s TEST environment - not certified. Switch to LIVE before selling for real.',
      status: signs && certified ? 'done' : 'todo',
      panel: signs ? 'core.device' : 'core.fiskaly',
      law: '§ 146a Abs. 1 AO',
      doc: 'fiskaly-setup.md',
    },
    {
      id: 'DE.receipt',
      title: 'A receipt for every sale (Belegausgabepflicht)',
      text: 'At an event in Germany the after-sale screen always shows the QR to the online receipt, with the print button beside it for paper on request. Nothing to set.',
      status: 'info',
      law: '§ 146a Abs. 2 AO',
    },
    {
      id: 'DE.closing',
      title: 'Close the day on every till',
      text:
        (f.closings ?? 0) > 0
          ? 'Tills close their day themselves when the day, event or currency changes; Cash up → Close the day does it by hand. Record the float and cash taken out under Cash in and out.'
          : 'Each till makes a closing (Kassenabschluss) per day: on its own when the day changes, or under Cash up → Close the day. Record the starting float and any cash taken out under Cash in and out so the box adds up in the export.',
      status: (f.closings ?? 0) > 0 ? 'done' : 'info',
      path: '/cashup',
      law: 'DSFinV-K, GoBD',
    },
    manual(f, {
      id: 'DE.register',
      title: 'Report each till and its TSE to the tax office',
      text: 'Within a month of the first sale, file the “Mitteilung über elektronische Aufzeichnungssysteme” in Mein ELSTER. Settings → Tax export (Germany) → Till register lists what to enter. Confirm here once filed.',
      panel: 'core.taxexport',
      law: '§ 146a Abs. 4 AO',
      doc: 'germany-compliance.md',
    }),
    manual(f, {
      id: 'DE.documentation',
      title: 'Write the Verfahrensdokumentation',
      text: 'The GoBD want a written description of how the till is used. docs/verfahrensdokumentation-vorlage.md is a German template with Zollify’s parts filled in - complete the bracketed parts and have your tax advisor read it.',
      law: 'GoBD Rz. 151 ff.',
      doc: 'verfahrensdokumentation-vorlage.md',
    }),
    {
      id: 'DE.export',
      title: 'DSFinV-K export ready for an inspection',
      text: on ? 'Settings → Tax export (Germany) checks a period and downloads the ZIP an inspector asks for. Try it once so you know where it is.' : 'Once Germany is switched on, Settings → Tax export (Germany) produces the DSFinV-K ZIP an inspector asks for.',
      status: 'info',
      panel: on ? 'core.taxexport' : undefined,
      law: '§ 146a Abs. 1 AO, DSFinV-K 2.4',
    },
    ...(code(f.homeCountry) !== c && !EU_COUNTRIES.includes(code(f.homeCountry))
      ? [
          manual(f, {
            id: 'DE.foreign-vat',
            title: 'VAT registration for a non-EU business',
            text: 'A business established outside the EU cannot use the German or EU small-business exemption and normally needs a German VAT registration before selling at events in Germany (for Swiss businesses: Finanzamt Konstanz). Confirm with a Steuerberater.',
            law: '§ 19 UStG does not apply to non-EU businesses',
          }),
        ]
      : []),
  ];
}

function denmark(f: LegalFacts, c: string): LegalStep[] {
  const cvr = /^(DK)?\s*\d{8}$/.test(f.vatId.replace(/\s/g, '')) || Boolean(f.enterpriseNumber?.trim());
  const economicOn = f.modules.includes('economic');
  const consignmentOn = f.modules.includes('consignment');
  const steps: LegalStep[] = [
    {
      id: 'DK.cvr',
      title: 'CVR number on receipts',
      text: cvr ? 'Your CVR number prints on every receipt as “CVR”.' : 'Danish receipts must show the seller’s CVR number. Enter it as the VAT number under Business profile (8 digits, with or without DK).',
      status: cvr ? 'done' : 'todo',
      panel: 'core.profile',
      law: 'Momsbekendtgørelsen § 64',
      doc: 'denmark-compliance.md',
    },
    {
      id: 'DK.rate',
      title: '25 % VAT on sales and on shelf rent',
      text: 'Denmark has one rate and no exemption for stores above DKK 50,000 turnover. Sales and rent taken at the till charge 25 %; a consignment store charges it on the full price, not on its commission.',
      status: f.exemptCountries.map(code).includes('DK') ? 'todo' : 'info',
      panel: 'core.vat',
      law: 'Momsloven § 4 stk. 3 nr. 1; Skat ruling on stall rent',
    },
    {
      id: 'DK.books',
      title: 'Sales reach a registered bookkeeping system',
      text: economicOn
        ? f.economic?.grant
          ? 'The e-conomic module books each day’s sales as a voucher in your registered system.'
          : 'The e-conomic module is on but not connected - grant it access under Settings → e-conomic.'
        : 'The bookkeeping act wants the books in a registered digital system. Switch on the e-conomic module (Settings → Modules) and connect it, or export the daily figures to your own registered system.',
      status: economicOn && f.economic?.grant ? 'done' : 'todo',
      panel: economicOn ? 'economic.economic' : 'core.modules',
      law: 'Bogføringsloven 2022',
      doc: 'denmark-compliance.md',
    },
    {
      id: 'DK.cash',
      title: 'Accept cash, no card surcharge',
      text: 'Shops must take cash and may not add a fee to consumer card payments. Zollify has cash as a method and never surcharges customers.',
      status: 'info',
      law: 'Betalingsloven § 81',
    },
    {
      id: 'DK.mobilepay',
      title: 'Offer MobilePay',
      text: f.customMethods?.some((m) => /mobilepay/i.test(m))
        ? 'MobilePay is a payment method on this till.'
        : 'Danish customers expect MobilePay. Add it as a payment method under Settings → Payments (a custom method, like TWINT) so it is recorded as such.',
      status: f.customMethods?.some((m) => /mobilepay/i.test(m)) ? 'done' : f.customMethods === undefined ? 'info' : 'todo',
      panel: 'pos.payments',
    },
    manual(f, {
      id: 'DK.dpa',
      title: 'Data processing agreement with your host',
      text: 'Hosting the till for your business needs a data processing agreement (databehandleraftale) and EU hosting. Ask your Zollify host for theirs and keep a copy.',
      law: 'GDPR Art. 28',
    }),
  ];
  if (consignmentOn) {
    const list = f.consignors ?? [];
    const missing = list.filter((a) => !a.selfBillingAgreedOn);
    steps.splice(3, 0, {
      id: 'DK.self-billing',
      title: 'Self-billing agreement with every artist',
      text: !list.length
        ? 'Artist payout statements are self-billing invoices: each needs a written agreement, both CVR numbers, and no VAT line for artists who are not VAT-registered. Tick “self-billing agreed” on each artist as you sign them up.'
        : missing.length
          ? `${missing.length} of ${list.length} artist${list.length === 1 ? '' : 's'} without a self-billing agreement: ${missing.slice(0, 3).map((a) => a.name).join(', ')}${missing.length > 3 ? ', …' : ''}. Tick “self-billing agreed” on each once signed.`
          : 'Every artist has a self-billing agreement on record; statements carry both CVR numbers and leave out VAT for unregistered artists.',
      status: list.length && !missing.length ? 'done' : 'todo',
      path: '/m/consignment',
      law: 'Momsbekendtgørelsen § 58 (afregningsbilag)',
    });
  }
  steps.push({
    id: 'DK.tier-b',
    title: 'Cafés, restaurants, grocers and kiosks: certified till required',
    text: 'Businesses in those four sectors (or ordered by Skat) must use a till with a signed electronic journal and SAF-T export. Zollify does not do this yet - a consignment or art shop is not in those sectors, but if your main activity is one of them, Zollify cannot be your till.',
    status: 'info',
    law: 'Momsbekendtgørelsen § 63',
    doc: 'denmark-compliance.md',
  });
  return steps;
}

function belgium(f: LegalFacts): LegalStep[] {
  const ent = Boolean(f.enterpriseNumber?.trim()) || /^BE\s?0\d{3}[.\s]?\d{3}[.\s]?\d{3}$/i.test(f.vatId.trim());
  return [
    {
      id: 'BE.enterprise',
      title: 'Enterprise number on receipts',
      text: ent ? 'Your enterprise number (ondernemingsnummer / numéro d’entreprise) prints on receipts.' : 'Belgian receipts show the enterprise number. Enter it under Business profile; the VAT number follows from it.',
      status: ent ? 'done' : 'todo',
      panel: 'core.profile',
      law: 'KB nr. 1, art. 5',
    },
    {
      id: 'BE.peppol',
      title: 'E-invoices for business customers (Peppol)',
      text: f.modules.includes('peppol-be')
        ? 'The Peppol module issues structured e-invoices to Belgian business customers.'
        : 'Since 2026 invoices between Belgian businesses must be structured e-invoices over Peppol. Only needed if you invoice businesses - switch on the Peppol module under Modules when you do.',
      status: f.modules.includes('peppol-be') ? 'done' : 'info',
      panel: f.modules.includes('peppol-be') ? 'peppol-be.peppol' : 'core.modules',
      law: 'Wet van 6 februari 2024 (B2B e-invoicing)',
    },
    {
      id: 'BE.gks',
      title: 'Food and drink: registered cash register (GKS)',
      text: 'A business serving food or drink above EUR 25,000 a year needs a certified “witte kassa” with a fiscal data module. Zollify is not one; this does not apply to selling goods.',
      status: 'info',
      law: 'KB 30 december 2009 (GKS)',
    },
  ];
}

function switzerland(f: LegalFacts): LegalStep[] {
  const uid = /^CHE[-\s]?\d{3}[.\s]?\d{3}[.\s]?\d{3}/i.test(f.vatId.trim());
  const exempt = f.exemptCountries.map(code).includes('CH');
  return [
    {
      id: 'CH.uid',
      title: 'UID with MWST on receipts, or below the threshold',
      text: exempt
        ? 'You are not VAT-registered in Switzerland (turnover under CHF 100,000). Receipts show no VAT.'
        : uid
          ? 'Your UID prints on receipts as CHE-…  MWST, with the VAT per rate.'
          : 'VAT-registered businesses show their UID with the MWST suffix on receipts. Enter it under Business profile, or mark Switzerland as exempt under VAT if you are under the CHF 100,000 threshold.',
      status: exempt || uid ? 'done' : 'todo',
      panel: uid || exempt ? 'core.vat' : 'core.profile',
      law: 'MWSTG Art. 26',
    },
    {
      id: 'CH.customs',
      title: 'Customs paperwork for events abroad',
      text: f.modules.includes('customs-ch')
        ? 'The Swiss customs module prepares the forms and goods lists from your claimed stock.'
        : 'Taking stock to an event in the EU and back crosses a customs border. The Swiss customs module (Settings → Modules) prepares the declaration and goods lists from your claimed stock.',
      status: f.modules.includes('customs-ch') ? 'done' : f.eventCountries.some((e) => code(e) !== 'CH') ? 'todo' : 'info',
      panel: 'core.modules',
    },
  ];
}

function austria(): LegalStep[] {
  return [
    {
      id: 'AT.rksv',
      title: 'Registrierkassenpflicht - signature unit required',
      text: 'Austria requires an electronic till with a certified signature unit (RKSV) and a receipt for every sale once turnover passes EUR 15,000 with EUR 7,500 in cash. Zollify has no RKSV signature yet. Exempt: outdoor sales at markets and stands (“Kalte-Hände-Regelung”) up to EUR 30,000 a year - check whether your event qualifies, otherwise use a certified till in Austria.',
      status: 'blocked',
      law: '§ 131b BAO, RKSV',
    },
  ];
}

function france(): LegalStep[] {
  return [
    {
      id: 'FR.nf525',
      title: 'Certified till software (NF 525 / LNE)',
      text: 'A VAT-registered business in France must use till software certified against the anti-fraud rules (NF 525 or an LNE certificate). Zollify is not certified. Small businesses under the franchise en base de TVA are exempt from this rule - otherwise use a certified till for sales in France.',
      status: 'blocked',
      law: 'Art. 286 I 3° bis CGI',
    },
  ];
}

function italy(): LegalStep[] {
  return [
    {
      id: 'IT.rt',
      title: 'Registratore telematico required',
      text: 'Sales to consumers in Italy must be recorded on a certified telematic register that reports to the Agenzia delle Entrate, or through its online “documento commerciale” procedure. Zollify is not one; a non-resident business at a fair also needs an Italian VAT position or representative. Check with an Italian commercialista before selling there.',
      status: 'blocked',
      law: 'D.Lgs. 127/2015 art. 2',
    },
  ];
}

function nordics(c: string): LegalStep[] {
  return [
    {
      id: `${c}.control-unit`,
      title: c === 'SE' ? 'Certified cash register with control unit' : 'Certified cash register system',
      text:
        c === 'SE'
          ? 'Swedish businesses selling for cash or card need a Skatteverket-approved cash register with a control unit. Zollify is not approved. Exemptions exist for small volumes (under 4 price base amounts a year) and for outdoor market sales - check yours.'
          : 'Norwegian businesses need a cash register system declared compliant with the Kassasystemlova. Zollify has not been declared. Small turnover (under NOK 50,000) and occasional market sales may be exempt - check with Skatteetaten.',
      status: 'blocked',
      law: c === 'SE' ? 'Skatteförfarandelagen 39 kap.' : 'Kassasystemlova',
    },
  ];
}

function netherlands(f: LegalFacts): LegalStep[] {
  return [
    {
      id: 'NL.kor',
      title: 'VAT or the small-business scheme (KOR)',
      text: f.exemptCountries.map(code).includes('NL')
        ? 'Under the KOR you charge no VAT and show none on receipts; you cannot deduct input VAT either.'
        : 'Charge Dutch VAT per product (21 % standard, 9 % for books), or apply for the KOR if turnover stays under EUR 20,000.',
      status: 'info',
      panel: 'core.vat',
      law: 'Wet OB art. 25',
    },
    {
      id: 'NL.receipts',
      title: 'No certified till, receipts on request',
      text: 'The Netherlands has no till certification. Receipts to consumers are not mandatory but must be given when asked; the records must be kept 7 years.',
      status: 'info',
      law: 'AWR art. 52',
    },
  ];
}

const BUILDERS: Record<string, (f: LegalFacts, c: string) => LegalStep[]> = {
  DE: germany,
  DK: denmark,
  BE: (f) => belgium(f),
  CH: (f) => switzerland(f),
  AT: () => austria(),
  FR: () => france(),
  IT: () => italy(),
  SE: (_, c) => nordics(c),
  NO: (_, c) => nordics(c),
  NL: (f) => netherlands(f),
};

function summarise(steps: LegalStep[]): string {
  if (steps.some((s) => s.status === 'blocked')) return 'Zollify cannot be the till here without an exemption';
  const open = steps.filter((s) => s.status === 'todo' || (s.status === 'manual' && !s.confirmedOn)).length;
  if (!open) return 'All set';
  return `${open} step${open === 1 ? '' : 's'} to do`;
}

/** The checklist per country the business sells in. */
export function legalChecklist(f: LegalFacts): CountryChecklist[] {
  return countriesInPlay(f).map(({ code: c, reason }) => {
    const specific = BUILDERS[c]?.(f, c) ?? [];
    // A country that blocks the till needs no profile talk; its own steps say what to do.
    const steps = specific.some((s) => s.status === 'blocked') ? specific : [...specific, ...commonSteps(f, c)];
    return { code: c, name: name(c), reason, steps, summary: summarise(steps) };
  });
}

/** How many steps are still open across every country - for a badge. */
export function openLegalSteps(lists: CountryChecklist[]): number {
  return lists.reduce((n, l) => n + l.steps.filter((s) => s.status === 'todo' || (s.status === 'manual' && !s.confirmedOn)).length, 0);
}
