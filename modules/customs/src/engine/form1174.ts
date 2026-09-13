/** Formular 11.74 (temporary admission) — exact port of legacy print1174() (golden-tested). */
import { compute1174Groups, countryToCode, esc } from './calc';
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

  // ── Helpers ──
  const fv = (v: string, warn = false) =>
    v ? `<span class="fv${warn ? ' warn' : ''}">${esc(v)}</span>` : `<span class="ev">——</span>`;
  const fvP = (v: string) => (v ? `<span class="fv pre">${esc(v)}</span>` : `<span class="ev">——</span>`);

  function cellHead(num: string, label: string): string {
    return `<div class="ch"><span class="cn">${esc(num)}</span><span class="cl">${esc(label)}</span></div>`;
  }

  function gtCell(val: string, align = ''): string {
    const s = align ? ` style="text-align:${align}"` : '';
    return val ? `<td${s}><span class="gfv">${esc(val)}</span></td>` : `<td${s}></td>`;
  }

  function gtDescRow(rowNum: number, f16: string, f17: string): string {
    return `<tr>
      <td class="rn">${rowNum}</td>
      ${gtCell(f16)}
      ${gtCell(f17)}
    </tr>`;
  }

  function gtNumRow(rowNum: number, f20: string, f22: string, f23: string, f24: string, f25: string): string {
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
          <div class="hfield-label">${cellHead('10', "Ursprungsland / Pays d'origine / Paese d'origine")}</div>
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
          ${cellHead('13', "Verwendungszweck der Ware / Emploi de la marchandise / Scopo d'impiego della merce")}
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
          ${cellHead('5', "VTS/SMT · Immat. Land / Pays d'immatr. / Paese d'immatr. · PLZ/NPA/CAP")}
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
          ${cellHead('15', "Abschlusszollstelle / Bureau de douane d'apurement / Ufficio doganale della conclusione")}
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
          ${gtNumRow(
            1,
            g1.tariffNo !== '—' ? g1.tariffNo : '',
            String(Math.round(g1.weightKg)),
            String(g1.qty),
            String(Math.round(g1.weightKg)),
            String(Math.floor(g1.value)),
          )}
          ${
            hasG2
              ? gtNumRow(
                  2,
                  g2.tariffNo !== '—' ? g2.tariffNo : '',
                  String(Math.round(g2.weightKg)),
                  String(g2.qty),
                  String(Math.round(g2.weightKg)),
                  String(Math.floor(g2.value)),
                )
              : ''
          }
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

  return html;
}
