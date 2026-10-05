/**
 * Formular 11.74 (temporary admission).
 *
 * Field values come from the legacy print1174() port (golden-tested value
 * for value); the layout follows BAZG's published form box for box - see
 * form-layout.ts.
 */
import { compute1174Groups, countryToCode } from './calc';
import { box, checkbox, fill, fv, gv, label, sheet } from './form-layout';
import { COUNTRY_BY_CODE } from './data';
import type { CustomsState } from './model';

export function build1174Html(state: CustomsState, now: Date = new Date()): string {
  const m = state.meta;
  const a = state.artist;
  const e = state.edec;

  // ── Data preparation ──
  const artistCC = countryToCode(a.countryOfOrigin) || '';
  const artistCountryName = COUNTRY_BY_CODE[artistCC] || artistCC;
  const senderBlock = [a.companyName, a.fullName, a.street, a.postCodeCity, artistCountryName].filter(Boolean).join('\n');
  const venueLines = [m.event, m.venueStreet, [m.venuePostcode, m.venueCity].filter(Boolean).join(' '), m.venueCountry || '']
    .filter(Boolean)
    .join('\n');
  // Box 3 is the importer: the booth bringing the goods in, care of the
  // venue where they are used - the venue alone read as if the event itself
  // imported the stock. The venue's Swiss address stays, matching box 5's PLZ.
  const artistNames = [a.companyName, a.fullName].filter(Boolean);
  const recipientLines = artistNames.length
    ? [...artistNames, m.event ? `c/o ${m.event}` : '', m.venueStreet, [m.venuePostcode, m.venueCity].filter(Boolean).join(' '), m.venueCountry || '']
        .filter(Boolean)
        .join('\n')
    : venueLines;
  // Box 28, the user of the goods: whoever actually has control of them (the
  // form's own instructions) - the booth itself.
  const userOfGoods = artistNames.join(', ');

  const vehicleCC = (e.transportationCountry || '').trim().toUpperCase();
  const transportMode = e.transportMode || '3';
  const isAir = transportMode === '4';
  const flightNumber = (e.flightNumber || '').trim();

  // VTS code per transport mode
  const VTS_CODE: Record<string, string> = { '1': '80', '2': '20', '3': '30', '4': '40', '5': '50', '9': '90' };
  const vtsCode = VTS_CODE[transportMode] || '30';

  // Country: vehicle CC for road; artist CC for air, rail, and all other modes
  const field5CC = transportMode === '3' ? vehicleCC || artistCC : artistCC;
  // Postal code: always the event/venue postal code
  const field5PostCode = (m.venuePostcode || '').trim() || '______';

  // ── Product grouping ──
  const { g1, g2, hasG2 } = compute1174Groups(state);

  const allTitles = state.products.map((p) => p.title).filter(Boolean).join(', ');
  const today = now.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // ── Layout (frame mm, measured off formular_11_74.pdf) ──
  const W = 181.5;
  const H = 279;
  const L = 90.5; // left/right column split
  const V = 168; // value column for 10-12
  const numRow = (y: number, r: { tariff: string; net: string; qty: string; gross: string; value: string }): string =>
    [
      box(0, y, 4.5, 8.5, '', 'thick-l'),
      box(4.5, y, 5, 8.5),
      box(9.5, y, 28, 8.5, `<div class="val c">${gv(r.tariff)}</div>`),
      box(37.5, y, 11, 8.5),
      box(48.5, y, 22, 8.5, `<div class="val r">${gv(r.net)}</div>`),
      box(70.5, y, 20, 8.5, `<div class="val c">${gv(r.qty)}</div>`),
      box(90.5, y, 23.5, 8.5, `<div class="val r">${gv(r.gross)}</div>`),
      box(114, y, 22.5, 8.5, `<div class="val r">${gv(r.value)}</div>`),
      box(136.5, y, 20.5, 8.5),
      box(157, y, 17.5, 8.5),
      box(174.5, y, W - 174.5, 8.5),
    ].join('');
  const grp = (g: typeof g1) => ({
    tariff: g.tariffNo !== '-' ? g.tariffNo : '',
    net: String(Math.round(g.weightKg)),
    qty: String(g.qty),
    gross: String(Math.round(g.weightKg)),
    value: String(Math.floor(g.value)),
  });
  const empty = { tariff: '', net: '', qty: '', gross: '', value: '' };

  const body = [
    // Left column: 1-5
    box(0, 0, L, 25, label('1', ['Versender', 'Expéditeur', 'Speditore']) + `<div class="val beside">${fv(senderBlock, true)}</div>`, 'thick-l thick-t'),
    box(0, 25, L, 17, label('2', ['Eigentümer der Ware', 'Propriétaire de la marchandise', 'Proprietario della merce']) + `<div class="val beside">${fv(senderBlock, true)}</div>`, 'thick-l'),
    box(0, 42, L, 25, label('3', ['Empfänger/Importeur', 'Destinataire/Importateur', 'Destinatario/Importatore']) + `<div class="val beside">${fv(recipientLines, true)}</div>`, 'thick-l'),
    box(0, 67, L, 17,
      label('4', ['Präferenzbehandlung - Régime préférentiel - Trattamento preferenziale']) +
      `<div style="display:flex;gap:3mm;margin:0.3mm 0 0 3.4mm">${checkbox(false, ['Europäische Freihandelszone', 'Zone européenne de libre-échange', 'Zona europea di libero scambio'])}${checkbox(false, ['Allgemeines Präferenzsystem', 'Système généralisé de préférences', 'Sistema generale di preferenze'])}</div>` +
      `<div style="display:flex;gap:6mm;margin:0.3mm 0 0 3.4mm">${label('', ['WVB/UZ  Nr.', 'CCM/CO  No', 'CCM/CO  N.'])}${label('', ['vom', 'du', 'del'])}</div>`, 'thick-l'),
    box(0, 84, L, 8.5,
      `<div style="display:flex;gap:3mm;align-items:flex-start">${label('5', ['VTS', 'SMT'])}<div class="val" style="margin-top:0">${fv(vtsCode)}</div>` +
      `${label('', ['Immatr. Land', "Pays d'immatr.", "Paese d'immatr."])}<div class="val" style="margin-top:0">${fv(field5CC || '______')}</div>` +
      `${label('', ['PLZ', 'NPA'])}<div class="val" style="margin-top:0">${fv(field5PostCode)}</div></div>`, 'thick-l'),
    // Right column: 6, form number, 7-15
    box(L, 0, 136.5 - L, 16.5, label('6', ['Vordokument', 'Document précédent', 'Documento precedente']) + (isAir && flightNumber ? `<div class="val">${fv(flightNumber)}</div>` : ''), 'thick-t'),
    box(136.5, 0, W - 136.5, 7.5, `<div class="form-no">11.74</div>`, 'thick-t'),
    box(136.5, 7.5, W - 136.5, 9, label('', ['Nr.', 'No', 'N.'])),
    box(L, 16.5, 136.5 - L, 8.5, label('7', ['Konto-Nr.', 'Compte No', 'Conto N.'])),
    box(136.5, 16.5, W - 136.5, 8.5,
      `<div style="display:flex;justify-content:space-between;align-items:center">${label('8', [])}${checkbox(true, ['Einfuhr', 'Import.', 'Import.'])}${checkbox(false, ['Ausfuhr', 'Export.', 'Esport.'])}</div>`),
    box(L, 25, W - L, 8.5, label('9', ['Verfalldatum', 'Echéance', 'Scadenza'])),
    box(L, 33.5, V - L, 8.5, label('10', ['Ursprungsland', "Pays d'origine", "Paese d'origine"])),
    box(V, 33.5, W - V, 8.5, `<div class="val c">${fv(artistCC)}</div>`),
    box(L, 42, V - L, 8.5, label('11', ['Land der vorübergehenden Bestimmung', 'Pays de destination temporaire', 'Paese di destinazione temporanea'])),
    box(V, 42, W - V, 8.5, `<div class="val c">${fv(countryToCode(m.venueCountry) || 'CH')}</div>`),
    box(L, 50.5, V - L, 8.5, label('12', ['Land der endgültigen Bestimmung', 'Pays de destination définitive', 'Paese di destinazione definitiva'])),
    box(V, 50.5, W - V, 8.5, `<div class="val c">${fv(artistCC)}</div>`),
    box(L, 59, W - L, 16.5, label('13', ['Verwendungszweck der Ware', 'Emploi de la marchandise', "Scopo d'impiego della merce"]) + `<div class="val">${fv('Verkauf an Ausstellungen / Messen · Vente aux expositions / foires')}</div>`),
    box(L, 75.5, W - L, 8.5,
      `<div style="display:flex;justify-content:space-between;align-items:center;padding-right:2mm">${label('14', ['Mietgeschäft', 'Location', 'Locazione'])}${checkbox(false, ['ja', 'oui', 'sì'])}${checkbox(false, ['nein', 'non', 'no'])}</div>`),
    box(L, 84, W - L, 8.5, label('15', ['Abschlusszollstelle', "Bureau de douane d'apurement", 'Ufficio doganale della conclusione'])),
    // 16 / 17: marks and description
    box(0, 92.5, 37.5, 8.5, label('16', ['Zeichen, Nr., Anzahl, Verpackung', 'Marque, no, nombre, emballage', 'Marca, n., quantità, imballaggio'], 'sm'), 'thick-l'),
    box(37.5, 92.5, W - 37.5, 8.5, label('17', ['Genaue Warenbezeichnung (Material, Typ, Nummern, etc.), die eine Identifikation der Ware sicherstellt', 'Désignation exacte de la marchandise (matière, type, numéros, etc.) garantissant son identification', "Designazione esatta della merce (materiale, tipo, numeri, ecc.), che garantisce l'identificazione della merce"], 'sm')),
    box(0, 101, 37.5, 17, `<div class="val">${gv('see attached list')}</div>`, 'thick-l'),
    box(37.5, 101, W - 37.5, 17, `<div class="val">${gv(allTitles || '-')}</div>`),
    box(0, 118, 37.5, 17, '', 'thick-l'),
    box(37.5, 118, W - 37.5, 17),
    // 18-27 header
    box(0, 135, 4.5, 8.5, label('', ['18', 'NHW', 'MNC'], 'sm c'), 'thick-l'),
    box(4.5, 135, 5, 8.5, label('', ['19', 'VC', 'CT'], 'sm c')),
    box(9.5, 135, 28, 8.5, label('20', ['Tarif-Nr.', 'No de tarif', 'Voce di tariffa'], 'sm')),
    box(37.5, 135, 11, 8.5, label('21', ['Schlüssel', 'Clé', 'N. conv.'], 'sm')),
    box(48.5, 135, 22, 8.5, label('22', ['Eigenmasse', 'Masse nette', 'Massa netta'], 'sm')),
    box(70.5, 135, 20, 8.5, label('23', ['Zusatzmenge', 'Unités suppl.', 'Unità suppl.'], 'sm')),
    box(90.5, 135, 23.5, 8.5, label('24', ['Rohmasse', 'Masse brute', 'Massa lorda'], 'sm')),
    box(114, 135, 22.5, 8.5, label('25', ['Stat. Wert in CHF', 'Valeur stat. CHF', 'Valore stat. CHF'], 'sm')),
    box(136.5, 135, 20.5, 8.5, label('26', ['Ansatz', 'Taux', 'Aliquota'], 'sm')),
    box(157, 135, W - 157, 8.5, label('27', ['Betrag', 'Montant', 'Importo'], 'sm')),
    numRow(143.5, grp(g1)),
    numRow(152, hasG2 ? grp(g2) : empty),
    // 28-31 and the duties block
    box(0, 160.5, L, 25,
      label('28', ['Verwender der Ware', 'Utilisateur de la marchandise', 'Utilizzatore della merce']) +
      `<div class="val beside">${fv(userOfGoods)}</div>` +
      `<div style="position:absolute;left:0.8mm;top:15.5mm;display:flex;gap:22mm">${label('29', ['MWST-Nr.', 'No TVA', 'N. IVA'])}${label('', ['MWST-Code', 'Code-TVA', 'Codice-IVA'])}</div>`, 'thick-l'),
    fill(15.5, 51, 183.5),
    fill(69, 89, 183.5),
    box(L, 160.5, 157 - L, 8.5),
    box(L, 169, 157 - L, 8.5),
    box(L, 177.5, 157 - L, 8),
    box(157, 160.5, W - 157, 17, label('32', ['Zollabgaben', 'Droits de douane', 'Tributi doganali'])),
    box(157, 177.5, 17.5, 8),
    box(174.5, 177.5, W - 174.5, 8),
    box(0, 185.5, L, 9, label('30', ['Bewilligung usw.', 'Permis, etc.', 'Permesso, ecc.']), 'thick-l'),
    box(L, 185.5, 157 - L, 9),
    box(157, 185.5, 17.5, 9, label('', ['Subtotal', 'Total int.', 'Subtotale'])),
    box(174.5, 185.5, W - 174.5, 9),
    box(0, 194.5, L, 25,
      `<div class="lv">${label('31', ['Ort/Datum', 'Lieu/date', 'Luogo/data'])}<div class="val">${fv(today)}</div></div>` +
      `<div class="lv">${label('', ['Der Anmelder', 'Le déclarant', 'Il dichiarante'])}<div class="val">${fv(a.fullName || '-')}</div></div>` +
      `<div class="lv">${label('', ['Ref.', 'Réf.', 'Rif.'])}</div>`, 'thick-l'),
    box(L, 194.5, 114 - L, 8.5, label('', ['MWST-Wert', 'Valeur-TVA', 'Valore-IVA'])),
    box(114, 194.5, 157 - 114, 8.5),
    box(L, 203, 114 - L, 8, label('', ['Einfuhrabgaben', "Redevances d'entrée", "Diritti d'entrata"])),
    box(114, 203, 157 - 114, 8),
    box(L, 211, 114 - L, 8.5, label('', ['MWST', 'TVA', 'IVA'])),
    box(114, 211, 157 - 114, 8.5, label('', ['von', '% de Fr.', 'di'])),
    box(157, 194.5, W - 157, 25, `<div style="text-align:center;font-size:15pt;line-height:1;margin-top:5mm">&#x2190;</div><div style="text-align:center;font-size:17pt;line-height:1;margin-top:2mm">=</div>`),
    // Customs use
    box(0, 219.5, 122, 42.5, label('', ['Zollbefund - Résultat de la vérification - Risultato della visita']), 'thick-l'),
    box(0, 262, 20.5, 8.5, label('', ['Zollkennzeichen', 'Marques douan.', 'Contrassegni dog.'], 'sm'), 'thick-l'),
    box(20.5, 262, 101.5, 8.5, label('', ['Erneuerung von 11.74 Nr.', 'Renouvellement du 11.74 no', 'Rinnovo carta di 11.74 n.'], 'sm')),
    box(0, 270.5, 20.5, H - 270.5, label('', ['Anzahl', 'Nombre', 'Quantità'], 'sm'), 'thick-l'),
    box(20.5, 270.5, 101.5, H - 270.5, label('', ['Dat. der Ein-/Ausfuhr', "Date de l'imp./l'exp.", "Data dell'imp./esp."], 'sm')),
    box(122, 219.5, 157 - 122, 9, label('', ['Einfuhrabgaben', "Redevances d'entrée", "Diritti d'entrata"])),
    box(157, 219.5, W - 157, 9),
    box(122, 228.5, W - 122, 9.5, label('', ['Annahme', 'Acceptation', 'Accettazione'])),
    box(122, 238, W - 122, 10, label('', ['Kontrolle', 'Contrôle', 'Controllo'])),
    box(122, 248, 153 - 122, H - 248),
    box(153, 248, W - 153, H - 248),
  ].join('');

  return sheet({
    title: `Formular 11.74 -${m.event || 'ZollTool'}`,
    hint: `Pre-filled values in <strong style="color:#6699ee">bold blue</strong> · Verify all fields before signing · Der Anmelder: the person paying the customs deposit · Generated ${today}`,
    color: '#f39fc8',
    formNumber: '11.74',
    header: {
      federation: ['Schweizerische Eidgenossenschaft', 'Confédération suisse', 'Confederazione Svizzera', 'Confederaziun svizra'],
      office: ['Eidgenössische Zollverwaltung EZV', 'Administration fédérale des douanes AFD', 'Amministrazione federale delle dogane AFD'],
    },
    sideTitle: ['Vorübergehende Verwendung mit hinterlegtem Betrag', 'Admission temporaire à montant déposé', 'Ammissione temporanea con importo depositato'],
    sideInstructions: ['Anleitung für das Ausfüllen siehe Rückseite von Abschnitt D', 'Directives pour l’établissement voir au verso du feuillet D', "Istruzioni per l'allestimento vedi a tergo della cedola D"],
    stripFrom: 101,
    rowNumbers: [
      { y: 101, h: 17, n: '1' },
      { y: 118, h: 17, n: '2' },
      { y: 143.5, h: 8.5, n: '1' },
      { y: 152, h: 8.5, n: '2' },
    ],
    frameW: W,
    frameH: H,
    footerLeft: 'Form. 11.74  01.2019',
    footerRight: 'Nachdruck verboten / Reproduction interdite / Riproduzione vietata',
    body,
  });
}
