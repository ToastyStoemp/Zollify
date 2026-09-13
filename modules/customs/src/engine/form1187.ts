/** Formular 11.87 (temporary admission / conclusion) — exact port of legacy print1187() (golden-tested). */
import { compute1174Groups, countryToCode } from './calc';
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

  const X = (v: unknown) =>
    String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const fv = (v: string) => (v ? `<span class="fv">${X(v)}</span>` : `<span class="ev">——</span>`);
  const fvP = (v: string) => (v ? `<span class="fv pre">${X(v)}</span>` : `<span class="ev">——</span>`);
  function ch(num: string, label: string): string {
    return `<div class="ch"><span class="cn">${num}</span><span class="cl">${label}</span></div>`;
  }
  function gcell(v: unknown, align?: string): string {
    return v ? `<td style="text-align:${align || 'right'}"><span class="gfv">${X(String(v))}</span></td>` : '<td></td>';
  }

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

  // Build field 14 description: titles of products not completely sold out
  const allRetProds = [...(g1prods || []), ...(hasG2 ? g2prods || [] : [])];
  const allRetTitles = allRetProds
    .filter((p) => Math.max(0, (p.amount || 0) - (p.soldQty || 0)) > 0)
    .map((p) => p.title)
    .filter(Boolean)
    .join(', ');

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
            ${ch('1', 'Versender / Expéditeur / Speditore')}
            ${fvP(eventBlock)}
          </div>
          <div class="cell" style="min-height:12mm">
            ${ch('2', 'Eigentümer der Ware / Propriétaire de la marchandise / Proprietario della merce')}
            ${fvP(senderBlock)}
          </div>
          <div class="cell" style="min-height:12mm">
            ${ch('3', 'Empfänger/Importeur/Verwender / Destinataire/Importateur/Utilisateur / Destinatario/Importatore/Utilizzatore')}
            ${fvP(senderBlock)}
          </div>
          <div class="cell" style="min-height:16mm; border-bottom:none; flex:1">
            ${ch('4', 'ab 11.73/11.74')}
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
              ${ch('5', 'Vordokument / Document précédent / Documento precedente')}
              <div style="margin-top:1mm; font-size:5pt; color:#333">
                Nr. / No / N. &nbsp;<span style="border-bottom:0.5px solid #999;display:inline-block;min-width:22mm">&nbsp;</span>
              </div>
            </div>
            <div class="cell" style="flex:0 0 36mm">
              ${ch('6', 'Einfuhr / Import. &nbsp;&nbsp; Ausfuhr / Export.')}
              <div style="margin-top:1.5mm">
                <span class="cb"><span class="cb-box"></span> Einfuhr</span>
                <span class="cb"><span class="cb-box chk"></span> Ausfuhr</span>
              </div>
            </div>
          </div>
          <div class="cell hfield" style="min-height:7mm">
            <div class="hfield-label">${ch('7', "Ursprungsland / Pays d'origine / Paese d'origine")}</div>
            <div class="hfield-value">${fv(artistCC || '——')}</div>
          </div>
          <div class="cell hfield" style="min-height:7mm">
            <div class="hfield-label">${ch('8', 'Land der vorübergehenden Bestimmung / Pays de destination temporaire / Paese di destinazione temporanea')}</div>
            <div class="hfield-value">${fv(countryToCode(m.venueCountry) || 'CH')}</div>
          </div>
          <div class="cell hfield" style="min-height:7mm">
            <div class="hfield-label">${ch('9', 'Land der endgültigen Bestimmung / Pays de destination définitive / Paese di destinazione definitiva')}</div>
            <div class="hfield-value">${fv(artistCC || '——')}</div>
          </div>
          <div class="cell" style="min-height:8mm">
            ${ch('10', "Zweck der vorübergehenden Verwendung / But de l'admission temporaire / Scopo dell'ammissione temporanea")}
            ${fv('Verkauf an Ausstellungen / Messen · Vente aux expositions / foires')}
          </div>
          <div class="cell" style="min-height:8mm; border-bottom:none; flex:1">
            <div style="display:flex; gap:4mm; align-items:flex-start">
              <div>
                ${ch('11', 'Mietgeschäft / Location / Locazione')}
                <div style="margin-top:1mm">
                  <span class="cb"><span class="cb-box"></span> ja / oui / sì</span>
                  <span class="cb"><span class="cb-box"></span> nein / non / no</span>
                </div>
              </div>
              <div style="border-left:0.5px solid #ccc; padding-left:3mm; flex:1">
                ${ch('12', 'VKZ/MTS · Immat. Land · PLZ/NPA/CAP')}
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
            ${
              hasG2
                ? `<tr class="data-row">
              <td class="rn">2</td>
              <td></td><td></td>
              ${gcell(g2.retQty > 0 && g2.tariffNo !== '—' ? g2.tariffNo : '')}
              <td></td>
              ${gcell(g2.retQty > 0 ? Math.round(g2.retWeightKg) : '')}
              ${gcell(g2.retQty > 0 ? g2.retQty : '', 'center')}
              ${gcell(g2.retQty > 0 ? Math.round(g2.retWeightKg) : '')}
              ${gcell(g2.retQty > 0 ? g2.retValue : '')}
              <td></td>
            </tr>`
                : ''
            }
          </tbody>
        </table>
      </div>

      <!-- Footer: 24 + 25 -->
      <div class="footer">
        <div class="f24">
          ${ch('24', 'Ort / Datum · Lieu / Date · Luogo / Data')}
          <div style="margin-top:1mm"><span class="fv">${X(eventCity ? eventCity + ', ' : '')}${X(today)}</span></div>
          <div style="margin-top:2mm; font-size:4.8pt; color:#444">Der Anmelder / Le déclarant / Il dichiarante</div>
          <div style="margin-top:0.5mm"><span class="fv">${X(a.fullName || '——')}</span></div>
          <div class="sig-note">→ Recommended: same person who signed the 11.74</div>
          <div class="sig-line">Unterschrift / Signature / Firma</div>
          <div style="margin-top:1mm; font-size:4.5pt; color:#444">Ref. / Réf. / Rif. &nbsp;<span style="border-bottom:0.5px solid #999;display:inline-block;min-width:30mm">&nbsp;</span></div>
        </div>
        <div class="f25">
          ${ch('25', 'Mehrwertsteuer / Taxe sur la valeur ajoutée / Imposta sul valore aggiunto')}
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

  return html;
}
