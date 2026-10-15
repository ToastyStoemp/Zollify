# Selling in Germany: legal compliance for Zollify

Status: October 2026. Not tax advice - the foreign-seller and VAT-rate points in particular should be confirmed with a German Steuerberater before relying on them.

## What applies

### 1. KassenSichV / §146a AO (in force now)

- Every device that records sales needs a certified **TSE** (technical security device) that signs each transaction, cancellations included.
- Every sale must come with a **receipt** (Belegausgabepflicht), on paper or electronic.
- On request, sales data must be exportable as **DSFinV-K**, plus the TSE's own export.

### 2. Registering tills with the tax office (Mitteilungspflicht, since 2025)

- Each till and TSE must be reported to the Finanzamt through **ELSTER** within one month of starting or stopping use.
- Reported data: number and type of devices, serial numbers, dates, type of TSE.
- Fines of up to €25,000 for not reporting after being asked.

### 3. Planned law: digital receipts from 2028 (cabinet draft, August 2026)

- From **1 January 2028** paper receipts stop being mandatory; businesses must provide a **digital receipt** instead. The preferred method is a QR code on the till screen that the customer scans without an app.
- Customers can still ask for paper.
- The same draft requires an electronic till above €100,000 annual revenue, with possible exemptions for markets.
- Zollify's thank-you screen with the receipt QR is already close to this; the receipt behind it needs more content (see the table below).

### 4. GoBD bookkeeping rules

- Records must be unchangeable: cancellations are new entries, nothing is edited or deleted.
- Changes to products and prices must be traceable.
- Retention: 8 years for receipts, 10 years for books; records must stay readable.
- A written description of how the system is used (**Verfahrensdokumentation**) is required.

### 5. VAT: charged, or exempt as a small business

- **Exempt under the EU SME scheme** (a business established in an EU member state, exempt in other member states too): receipts in another member state must show at least the date, the **EX number**, the type and amount of the goods, and **a mention that the supply is VAT exempt under the SME scheme** (EU Commission guide to the SME scheme, section 4.7.5). At home, the national wording applies - in Germany since 2025 e.g. "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.", also on receipts up to €250.
- **Charging VAT**: receipts show the rate, and the VAT amount per rate. The rate depends on the product - in Germany the reduced 7% covers certain original artworks and books; most prints, stickers and pins are 19%. Confirm per product type.
- A business established **outside the EU** (e.g. Switzerland) can't use either exemption and normally needs a German VAT registration (for Swiss businesses: **Finanzamt Konstanz**).
- Being exempt from VAT does **not** remove the till rules: KassenSichV/TSE, receipts and registering tills still apply to an electronic till.

### 6. GDPR / DSGVO

- The online receipt page and the public events page need a privacy notice, and likely an imprint (Impressum).
- Host the receipt server in the EU or Switzerland.

### 7. E-invoicing

Mostly not relevant: sales to consumers and receipts up to €250 are exempt. It only matters if a business buyer needs a larger invoice.

## What Zollify needs

| Requirement | Today | Change needed |
|---|---|---|
| TSE signing | **Built**: fiskaly cloud TSE ready to use - see [`fiskaly-setup.md`](fiskaly-setup.md); Swissbit hardware driver pending. A sale in Germany starts a TSE transaction at its first item and is signed when recorded, over the receipt's figures (DSFinV-K `Kassenbeleg-V1`); an outage keeps the till selling and marks the sale and receipt "TSE ausgefallen". Devices with a TSE can be made **main TSE devices**: every device without one (a backup phone, a sale marked paid on another terminal) is assigned to one of them - once, with a warning, as a till belongs to exactly one TSE in normal operation (AEAO zu § 146a) - and signs there over the live connection, under its own till number. While the assigned one is out, another main TSE device signs as a stand-in (marked so in the export) and the outage is logged with start, end and reason, synced per till; with none reachable the sale is marked unsigned. A device moving to another TSE becomes a new till (new till serial number). Works today with an uncertified test TSE. | For hardware: the native Swissbit driver, once a TSE (and its SDK) is bought - see [`tse-swissbit.md`](tse-swissbit.md). Payment terminals (myPOS Carbon/Go 2, SumUp) don't provide a TSE; it belongs to the till software. |
| VAT per sale | **Done**: each event charges its country's standard or reduced rate per product (Settings → VAT, the event form, the product's "VAT rate"), or the small-business exemption; every sale keeps a snapshot (`tx.tax`) | Map the stored rates to DSFinV-K VAT keys when building the export. |
| Receipt content (§6 KassenSichV) | **Done**: seller name, address and VAT ID, date, a receipt number counted per till (sales and cancellations alike, never reused), the till, items, total, payment type; VAT and net per rate with lettered lines, or the exemption note and EX number; for signed sales the TSE transaction number, signature counter, start and end time, TSE serial and the DSFinV-K QR code (paper) - also on screen and on the online receipt. Settings warns when the profile lacks the name or address. | - |
| A receipt for every sale | **Done**: at an event in Germany the after-sale screen always shows the QR to the online receipt with the print button beside it, whatever the device's after-sale settings - paper on request. | - |
| Cancellations | **Done**: reverting a sale gives a cancellation receipt of its own - its own number, its own TSE signature, every amount negative, pointing to the receipt it cancels; reprinting a reverted sale prints both | - |
| DSFinV-K export | **Done**: Settings → Tax export (Germany) checks a period, lists what is missing (a day not closed, a receipt not synced, a test TSE) and downloads the ZIP: all 20 files with the official index.xml and DTD, built on the server from every device's synced records. Passes an independent DSFinV-K validator. See "How the export maps Zollify" below. | The TSE's certificate (from the Swissbit driver); the TSE's own TAR export (Swissbit driver). |
| Daily closing and cash movements | **Done**: each till closes itself when the day, event or currency changes before its next receipt, at start-up on a new day, or by hand (Cash up → Close the day); numbered per till, synced, never changed. Cash up → Cash in and out records the starting cash, money put in or taken out and cash to the bank, each as a receipt of its own on the till (numbered, TSE-signed in Germany, synced), counted into the closing's cash and exported as Anfangsbestand, Privateinlage, Privatentnahme or Geldtransit (VAT key 5). | - |
| Unchangeable records | **Done**: append-only change log, sales never deleted; practice is done in test payments mode (Settings → POS), which records no sales at all, so there is nothing to mark as training. | Keep as is. |
| Till registration | **Done**: Settings → Tax export (Germany) → Till register lists every till serial number with its device, first and last receipt and the TSEs that signed for it (test TSEs flagged), and copies as text for the ELSTER form - see "Reporting the tills" below. | The TSE's certification ID comes from its maker; a decommissioning date is the last receipt (or the day you retired the device). |
| Record keeping | Server keeps the change log for good; nothing is deleted by age. Only the online receipt *link* expires (400 days, `RECEIPT_TTL_DAYS`); the sale stays. | Keep server backups for 10 years (§ 147 AO); export a full DSFinV-K ZIP and a backup before closing an account. |
| Documentation | **Done**: [`verfahrensdokumentation-vorlage.md`](verfahrensdokumentation-vorlage.md) - a German template with Zollify's parts (system, data flow, TSE, export, retention) filled in and the business's parts marked to complete. | Fill it in; have the tax advisor read it. |
| Privacy and imprint | **Done**: the online receipt and the public events page carry an "Imprint & privacy" block - the business name, address and VAT number from the profile, a plain-language privacy notice (what the page shows, no cookies, the anti-guessing puzzle, how long the link lives, 10-year retention of the sale), and links to the business's own imprint and privacy pages when set under Settings → Business profile → Webstore and socials. `LEGAL_OPERATOR` names the hosting provider. | - |

## Suggested order

1. ~~Store VAT on each sale.~~ Done.
2. ~~TSE signing with outage handling~~ done, with the fiskaly cloud TSE (see `fiskaly-setup.md`); the Swissbit driver remains (see `tse-swissbit.md`).
3. ~~Receipt TSE block and QR, receipt numbers, cancellation receipts~~ done.
4. ~~Daily closings and cash movements~~ done.
5. ~~DSFinV-K export~~ done.
6. ~~Till registration data, documentation template, privacy and imprint~~ done.

Steps 1-3 are needed before selling at a German convention. Steps 4-5 are needed for a tax inspection (Kassennachschau / Außenprüfung).

## Reporting the tills (§ 146a Abs. 4 AO)

Since 1 January 2025 every electronic till and its TSE must be reported to the tax office within a month of first use,
and again within a month of taking it out of use - through **Mein ELSTER → Formulare → Mitteilung über die Verwendung
elektronischer Aufzeichnungssysteme**. Settings → Tax export (Germany) → **Till register** lists what to enter:

| ELSTER asks | Zollify gives |
|---|---|
| Betriebsstätte | your business address (Settings → Business profile); the tills are mobile and belong to it - confirm with the tax advisor |
| Art des Aufzeichnungssystems | computer-based till (software): "Zollify", version as shown |
| Seriennummer des Aufzeichnungssystems | the till serial number (`ZOLLIFY-…` or the one you set) |
| Anschaffungsdatum / Inbetriebnahme | the date of the first receipt (or the day you bought the device) |
| Außerbetriebnahme | the last receipt, once you retire a device - a till keeps its number for good; a new device is a new till |
| TSE: Art, Seriennummer, Zertifizierungs-ID, Inbetriebnahme | cloud TSE (fiskaly) or hardware (Swissbit); serial and first-signed date from the register; the certification ID (BSI-K-TR-…) from fiskaly's dashboard or the Swissbit data sheet |

Test TSEs (fiskaly TEST, Zollify's test TSE) are flagged in the register and are not reported.

## In the app: Settings → Legal setup

Settings → Legal setup turns this document into a checklist per country the business sells in (its home country, its stores, its events): what is already in place (read from the profile, VAT settings, TSE, modules and connections), what to set and where, and what happens outside Zollify (a filing, a signed agreement) for the owner to confirm. The rules are in `packages/shared/src/legal-checklist.ts`; this document carries the sources.

## Switching it on

Settings → Modules → Built in → **Germany (KassenSichV)**, per account. It shows the TSE settings (This device), closing the day (Cash up) and the tax export panel; switched off they are hidden. The signing itself is core and never follows the switch: a device that has a TSE (or signs through a main TSE device) keeps signing and keeps its screens. Creating or editing an event in Germany warns when its sales would go unsigned - the switch off, or no device with a TSE - and the event card says so too.

## How the export maps Zollify

- **Closing** (Z_NR) = one till's receipts for one day at one event in one currency. Z_KASSE_ID and KASSE_SERIENNR are the till serial number (the TSE client id).
- **Receipt** (BON_ID = BON_NR = the printed receipt number). Every sale is BON_TYP "Beleg". A cancellation is a "Beleg" of its own with BON_STORNO 1, every amount and quantity negative, and a reference (REF_TYP "Transaktion") to the receipt it cancels - the way the DSFinV-K wants it once a TSE is in use.
- **Lines**: GV_TYP "Umsatz" at what each line cost after discounts; the list price and the discount beside it (Bonpos_Preisfindung).
- **VAT keys** (Anlage 2): 19% → 1, 7% → 2, 10.7% → 3, 5.5% → 4; a sale exempt as a small business → 6 "Umsatzsteuerfrei" (common practice - **confirm with the Steuerberater**); a sale without VAT data → 7 and KEINE_UST_ZUORDNUNG.
- **Payments**: cash "Bar", everything else "Unbar" named after the method (e.g. "mypos", "TWINT").
- **Cash movements** (Cash up → Cash in and out): a "Beleg" of their own with one line - GV_TYP Anfangsbestand, Privateinlage, Privatentnahme or Geldtransit, VAT key 5 (not taxable), paid "Bar", negative going out - so Z_SE_BARZAHLUNGEN and cash_per_currency match the box.
- **Not exported yet**: carts abandoned after the TSE transaction started (AVBelegabbruch - signed on the TSE, so they are in the TSE's own export), training sales (AVTraining - there is no training mode), the TSE certificate.

## Sources

- [BMF: Draft law introducing the register requirement (Aug 2026)](https://www.bundesfinanzministerium.de/Content/DE/Gesetzestexte/Gesetze_Gesetzesvorhaben/Abteilungen/Abteilung_IV/21_Legislaturperiode/2026-08-07-G-Kassenpflicht/0-Gesetz.html)
- [beck-aktuell: Digital receipts to replace paper](https://www.beck-aktuell.de/heute-im-recht/rechtspolitik-gesetzgebung/bonpflicht-digitale-kassenbons-papierbelege-registrierkassen-2026-07-23)
- [Deutsche Handwerks Zeitung: Bonpflicht bleibt, nur anders](https://www.deutsche-handwerks-zeitung.de/bonpflicht-bleibt-nur-anders-was-der-gesetzentwurf-vorsieht-384034/)
- [IHK Darmstadt: Registrierkassenpflicht soll kommen, der Papierbon soll gehen](https://www.ihk.de/darmstadt/produktmarken/recht-und-fair-play/steuerinfo/registrierkassenpflicht-soll-kommen-der-papierbon-soll-gehen-7123986)
- [DEHOGA Berlin: Referentenentwurf liegt vor](https://dehoga-berlin.de/2026/08/14/registrierkassenpflicht-referentenentwurf-liegt-vor/)
- [Grant Thornton: Mitteilungspflicht für elektronische Kassensysteme](https://www.grantthornton.de/themen/2025/mitteilungspflicht-fuer-elektronische-kassensysteme-frist-endet-am-31.-juli-2025)
- [für-gründer.de: Meldepflicht für elektronische Kassensysteme](https://www.fuer-gruender.de/wissen/unternehmen-fuehren/buchhaltung/kasse/meldepflicht/)
- [RetailForce: FAQs Germany KassenSichV](https://support.retailforce.cloud/hc/en-gb/articles/4404423214993-FAQs-Germany-KassenSichV)
- [Travelmanager: Security with Cloud TSE](https://docs.travelmanager.de/en/docs/allgemein/sicherheit-mit-cloud-tse)
- [EU Commission: Guide to the SME scheme / explanatory notes](https://sme-vat-rules.ec.europa.eu/system/files/2024-10/sme-explanatory-notes_en.pdf)
- [EU Commission: Applying the cross-border SME scheme](https://sme-vat-rules.ec.europa.eu/sme-scheme/cross-border-sme-scheme_en)
- [mehrwertsteuerrechner.de: Kleinunternehmerregelung 2026](https://www.mehrwertsteuerrechner.de/kleinunternehmerregelung/)
- [EuroCompta: EU VAT rates 2026](https://eurocompta.eu/guides/eu-vat-rates/)
