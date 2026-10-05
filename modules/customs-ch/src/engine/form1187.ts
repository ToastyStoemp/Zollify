/**
 * Formular 11.87 (temporary admission / conclusion).
 *
 * Field values come from the legacy print1187() port (golden-tested value
 * for value); the layout follows BAZG's published form box for box - see
 * form-layout.ts.
 */
import { calcReturnStats, compute1174Groups, countryToCode } from './calc';
import { PURPOSE, box, checkbox, fill, fv, gv, label, sheet } from './form-layout';
import { COUNTRY_BY_CODE } from './data';
import type { CustomsState } from './model';

export function build1187Html(state: CustomsState, now: Date = new Date()): string {
  const m = state.meta;
  const a = state.artist;
  const e = state.edec;

  const artistCC = countryToCode(a.countryOfOrigin) || '';
  const artistCountryName = COUNTRY_BY_CODE[artistCC] || artistCC;
  const senderBlock = [a.companyName, a.fullName, a.street, a.postCodeCity, artistCountryName].filter(Boolean).join('\n');

  const transportMode = e.transportMode || '3';
  const vehicleCC = (e.transportationCountry || '').trim().toUpperCase();
  const VTS_CODE: Record<string, string> = { '1': '80', '2': '20', '3': '30', '4': '40', '5': '50', '9': '90' };
  const vtsCode = VTS_CODE[transportMode] || '30';
  const field12CC = transportMode === '3' ? vehicleCC || artistCC : artistCC;
  const field12PLZ = (m.venuePostcode || '').trim() || '______';
  const eventBlock = [m.event, m.venueStreet, [m.venuePostcode, m.venueCity].filter(Boolean).join(' '), m.venueCountry || '']
    .filter(Boolean)
    .join('\n');

  const today = now.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const eventCity = m.venueCity || '';

  const { g1, g2, hasG2, g1prods, g2prods } = compute1174Groups(state);

  // Build field 14 description: titles of products not completely sold out.
  // Same rule as the return goods list and the group totals above
  // (calcReturnStats): stock lives on each listed variant, not the parent's
  // flat amount/soldQty, and unlisted variants never count.
  const allRetProds = [...(g1prods || []), ...(hasG2 ? g2prods || [] : [])];
  const allRetTitles = allRetProds
    .filter((p) => calcReturnStats(p).retQty > 0)
    .map((p) => p.title)
    .filter(Boolean)
    .join(', ');

  // ── Layout (frame mm, measured off formular_11_87.pdf) ──
  const W = 181.8;
  const H = 279.6;
  const L = 91.4; // left/right column split
  const rows = (r: { tariff: string; net: string | number; qty: string | number; gross: string | number; value: string | number }, y: number): string =>
    [
      box(0, y, 5, 8.5),
      box(5, y, 5, 8.5),
      box(10, y, 28, 8.5, `<div class="val c">${gv(r.tariff)}</div>`),
      box(38, y, 11.5, 8.5),
      box(49.5, y, 22, 8.5, `<div class="val r">${gv(r.net)}</div>`),
      box(71.5, y, 19.9, 8.5, `<div class="val c">${gv(r.qty)}</div>`),
      box(91.4, y, 23, 8.5, `<div class="val r">${gv(r.gross)}</div>`),
      box(114.4, y, 32.9, 8.5, `<div class="val r">${gv(r.value)}</div>`),
      box(147.3, y, W - 147.3, 8.5),
      box(0, y + 8.5, 114.4, 13),
      box(114.4, y + 8.5, 32.9, 13),
      box(147.3, y + 8.5, W - 147.3, 13),
    ].join('');
  const g = (grp: typeof g1) =>
    grp.retQty > 0
      ? { tariff: grp.tariffNo !== '-' ? grp.tariffNo : '', net: Math.round(grp.retWeightKg), qty: grp.retQty, gross: Math.round(grp.retWeightKg), value: grp.retValue }
      : { tariff: '', net: '', qty: '', gross: '', value: '' };
  const empty = { tariff: '', net: '', qty: '', gross: '', value: '' };

  const body = [
    // Left column: 1-4
    box(0, 0, L, 25.1, label('1', ['Versender', 'Expéditeur', 'Speditore']) + `<div class="val beside">${fv(eventBlock, true)}</div>`, 'thick-l thick-t'),
    box(0, 25.1, L, 16.9, label('2', ['Eigentümer der Ware', 'Propriétaire de la marchandise', 'Proprietario della merce']) + `<div class="val beside">${fv(senderBlock, true)}</div>`, 'thick-l'),
    box(0, 42, L, 25.1, label('3', ['Empfänger/Importeur/Verwender', 'Destinataire/Importateur/Utilisateur', 'Destinatario/Importatore/Utilizzatore']) + `<div class="val beside" style="left:45mm">${fv(senderBlock, true)}</div>`, 'thick-l'),
    box(0, 67.1, L, 24.9,
      `<div style="display:flex;gap:3mm">${label('4', ['ab 11.73/11.74', '11.73/11.74', '11.73/11.74'])}${label('', ['Nr.', 'No', 'N.'])}</div>` +
      `<div style="margin-top:2.2mm">${label('', ['vom', 'du', 'del'])}</div>` +
      `<div style="margin-top:1.4mm">${label('', ['Zollstelle', 'Bureau de douane', 'Ufficio doganale'])}</div>`, 'thick-l'),
    fill(28.4, 90.6, 74.7),
    fill(28.4, 90.6, 82.7),
    fill(28.4, 90.6, 90.8),
    // Right column: 5, form number, 6-12
    box(L, 0, 137.3 - L, 25.1, label('5', ['Vordokument', 'Document précédent', 'Documento precedente']), 'thick-t'),
    box(137.3, 0, W - 137.3, 8, `<div class="form-no">11.87</div>`, 'thick-t'),
    box(137.3, 8, W - 137.3, 8, label('', ['Nr.', 'No', 'N.'])),
    box(137.3, 16, W - 137.3, 9.1,
      `<div style="display:flex;justify-content:space-between;align-items:center">${label('6', [])}${checkbox(false, ['Einfuhr', 'Import.', 'Import.'])}${checkbox(true, ['Ausfuhr', 'Export.', 'Esport.'])}</div>`),
    box(L, 25.1, 166.7 - L, 8.4, label('7', ['Ursprungsland', "Pays d'origine", "Paese d'origine"])),
    box(166.7, 25.1, W - 166.7, 8.4, `<div class="val c">${fv(artistCC || '--')}</div>`),
    box(L, 33.5, 166.7 - L, 8.5, label('8', ['Land der vorübergehenden Bestimmung', 'Pays de destination temporaire', 'Paese di destinazione temporanea'])),
    box(166.7, 33.5, W - 166.7, 8.5, `<div class="val c">${fv(countryToCode(m.venueCountry) || 'CH')}</div>`),
    box(L, 42, 166.7 - L, 8.5, label('9', ['Land der endgültigen Bestimmung', 'Pays de destination définitive', 'Paese di destinazione definitiva'])),
    box(166.7, 42, W - 166.7, 8.5, `<div class="val c">${fv(artistCC || '--')}</div>`),
    box(L, 50.5, 166.7 - L, 16.6, label('10', ['Zweck der vorübergehenden Verwendung', "But de l'admission temporaire", "Scopo dell'ammissione temporanea"]) + `<div class="val">${fv(PURPOSE)}</div>`),
    box(166.7, 50.5, W - 166.7, 16.6),
    box(L, 67.1, W - L, 8.4,
      `<div style="display:flex;justify-content:space-between;align-items:center;padding-right:2mm">${label('11', ['Mietgeschäft', 'Location', 'Locazione'])}${checkbox(false, ['ja', 'oui', 'sì'])}${checkbox(false, ['nein', 'non', 'no'])}</div>`),
    box(L, 75.5, W - L, 8.1,
      `<div style="display:flex;gap:4mm;align-items:flex-start">${label('12', ['VKZ', 'MTS'])}<div class="val" style="margin-top:0">${fv(vtsCode)}</div>` +
      `${label('', ['Immatr. Land', "Pays d'immatr."])}<div class="val" style="margin-top:0">${fv(field12CC || '______')}</div>` +
      `${label('', ['PLZ', 'NPA'])}<div class="val" style="margin-top:0">${fv(field12PLZ)}</div></div>`),
    box(L, 83.6, W - L, 8.4),
    // 13 / 14: marks and description
    box(0, 92, 38, 8.5, label('13', ['Zeichen, Nr., Anzahl, Verpackung', 'Marque, no, nombre, emballage', 'Marca, n., quantità imballaggio'], 'sm'), 'thick-l'),
    box(38, 92, W - 38, 8.5, label('14', ['Genaue Warenbezeichnung (Material, Typ, Nummern, etc.), die eine Identifikation der Ware erlaubt', "Désignation exacte de la marchandise (matériel, type, no, etc.) permettant son identification", "Designazione esatta della merce (materiale, tipo, n., ecc.) che ne permette l'identificazione"], 'sm')),
    box(0, 100.5, 38, 16.8, `<div class="val">${gv('See attached list')}</div>`, 'thick-l'),
    box(38, 100.5, W - 38, 16.8, `<div class="val">${gv(allRetTitles || '-')}</div>`),
    box(0, 117.3, 38, 17.2, '', 'thick-l'),
    box(38, 117.3, W - 38, 17.2),
    // 15-23 header
    box(0, 134.5, 5, 8, label('', ['15', 'NHW', 'MNC'], 'sm c'), 'thick-l'),
    box(5, 134.5, 5, 8, label('', ['16', 'VC', 'CT'], 'sm c')),
    box(10, 134.5, 28, 8, label('17', ['Tarif-Nr.', 'No de tarif', 'Voce di tariffa'], 'sm')),
    box(38, 134.5, 11.5, 8, label('18', ['Schlüssel', 'Clé', 'N. conv.'], 'sm')),
    box(49.5, 134.5, 22, 8, label('19', ['Eigenmasse', 'Masse nette', 'Massa netta'], 'sm')),
    box(71.5, 134.5, 19.9, 8, label('20', ['Zusatzmenge', 'Unités suppl.', 'Unità suppl.'], 'sm')),
    box(91.4, 134.5, 23, 8, label('21', ['Rohmasse', 'Masse brute', 'Massa lorda'], 'sm')),
    box(114.4, 134.5, 32.9, 8, label('22', ['Stat. Wert in CHF', 'Valeur stat. CHF', 'Valore stat. CHF'], 'sm')),
    box(147.3, 134.5, W - 147.3, 8, label('23', ['MWST-Wert', 'Valeur-TVA', 'Valore-IVA'], 'sm')),
    rows(g(g1), 142.5),
    rows(hasG2 ? g(g2) : empty, 164),
    // 24 / 25
    box(0, 185, L, 24.5,
      `<div class="lv">${label('24', ['Ort / Datum', 'Lieu / Date', 'Luogo / Data'])}<div class="val">${fv(`${eventCity ? eventCity + ', ' : ''}${today}`)}</div></div>` +
      `<div class="lv">${label('', ['Der Anmelder', 'Le déclarant', 'Il dichiarante'])}<div class="val">${fv(a.fullName || '--')}</div></div>` +
      `<div class="lv">${label('', ['Ref.', 'Réf.', 'Rif.'])}</div>`, 'thick-l'),
    box(L, 185, W - L, 24.5,
      label('25', ['Mehrwertsteuer', 'Taxe sur la valeur ajoutée', 'Imposta sul valore aggiunto']) +
      `<div style="margin-top:1mm">${label('', ['MWST-Code', 'Code-TVA', 'Codice-IVA'])}</div>` +
      `<div style="margin-top:0.8mm">${label('', ['MWST-Register-Nr.', "No d'enregistrement-TVA", 'N. di registrazione IVA'])}</div>`),
    fill(125.8, 138.9, 200.1),
    fill(125.8, 180.8, 207.6),
    // Customs use
    box(0, 209.5, 122.5, H - 209.5, label('', ['Zollbefund - Résultat de la vérification - Risultato della visita']), 'thick-l'),
    box(122.5, 209.5, W - 122.5, 20, label('', ['Annahme', 'Acceptation', 'Accettazione'])),
    box(122.5, 229.5, W - 122.5, 18.1, label('', ['Kontrolle', 'Contrôle', 'Controllo'])),
    box(122.5, 247.6, 153.3 - 122.5, H - 247.6),
    box(153.3, 247.6, W - 153.3, H - 247.6),
  ].join('');

  return sheet({
    title: `Formular 11.87 -${m.event || 'ZollTool'}`,
    hint: 'Formular 11.87 - Vorübergehende Verwendung / Abschluss · pre-filled preview · Der Anmelder: the same person who signed the 11.74',
    color: '#00a06b',
    formNumber: '11.87',
    header: {
      federation: ['Schweizerische Eidgenossenschaft', 'Confédération suisse', 'Confederazione Svizzera', 'Confederaziun svizra'],
      office: ['Bundesamt für Zoll und Grenzsicherheit BAZG', 'Office fédéral de la douane et de la sécurité des frontières OFDF', 'Ufficio federale della dogana e della sicurezza dei confini UDSC', 'Uffizi federal da la duana e da la segirezza dals cunfins UDSC'],
    },
    sideTitle: ['Vorübergehende Verwendung / Abschluss', 'Admission temporaire / Apurement', 'Ammissione temporanea / Conclusione'],
    sideInstructions: ['Anleitung für das Ausfüllen siehe Rückseite von Abschnitt C', "Directives pour l'établissement, voir au verso du feuillet C", "Istruzioni per l'allestimento, vedi a tergo della cedola C"],
    stripFrom: 100.5,
    rowNumbers: [
      { y: 100.5, h: 16.8, n: '1' },
      { y: 117.3, h: 17.2, n: '2' },
      { y: 142.5, h: 21.5, n: '1' },
      { y: 164, h: 21, n: '2' },
    ],
    frameW: W,
    frameH: H,
    footerLeft: 'Form. 11.87  1.2022',
    footerRight: 'Nachdruck verboten / Reproduction interdite / Riproduzione vietata',
    body,
  });
}
