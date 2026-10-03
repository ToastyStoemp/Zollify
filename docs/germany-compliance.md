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
| TSE signing | **Built, driver pending**: a sale in Germany starts a TSE transaction at its first item and is signed when recorded, over the receipt's figures (DSFinV-K `Kassenbeleg-V1`); an outage keeps the till selling and marks the sale and receipt "TSE ausgefallen". Works today with an uncertified test TSE. | The native Swissbit driver, once a TSE (and its SDK) is bought - see [`tse-swissbit.md`](tse-swissbit.md). Payment terminals (myPOS Carbon/Go 2, SumUp) don't provide a TSE; it belongs to the till software. |
| VAT per sale | **Done**: each event charges its country's standard or reduced rate per product (Settings → VAT, the event form, the product's "VAT rate"), or the small-business exemption; every sale keeps a snapshot (`tx.tax`) | Map the stored rates to DSFinV-K VAT keys when building the export. |
| Receipt content (§6 KassenSichV) | **Done**: seller name, address and VAT ID, date, a receipt number counted per till (sales and cancellations alike, never reused), the till, items, total, payment type; VAT and net per rate with lettered lines, or the exemption note and EX number; for signed sales the TSE transaction number, signature counter, start and end time, TSE serial and the DSFinV-K QR code (paper) - also on screen and on the online receipt. Settings warns when the profile lacks the name or address. | - |
| A receipt for every sale | QR and printing are optional per device | A Germany mode (e.g. by event country) where every sale must offer a receipt by QR, print or both, with paper always available on request. |
| Cancellations | **Done**: reverting a sale gives a cancellation receipt of its own - its own number, its own TSE signature, every amount negative, pointing to the receipt it cancels; reprinting a reverted sale prints both | - |
| DSFinV-K export | CSV, PDF and backups only | A DSFinV-K export: till master data, daily closings, line items with VAT keys, payments and cash movements, plus the TSE export. |
| Daily closing and cash movements | Cash-up screen; starting cash stored on the device only | Numbered daily closings, and recorded cash put in or taken out (Einlagen/Entnahmen), synced to the server and never changed afterwards. |
| Unchangeable records | Append-only change log, sales never deleted (good) | Keep as is. Add a training-mode flag so practice sales are marked as such. |
| Till registration | Device list with names | Store a serial number and start and end dates per device, and generate the data to enter in ELSTER. |
| Record keeping | Server keeps the change log; online receipts expire after 400 days | Keep server data and backups for 8 to 10 years, independent of the online receipt's expiry. |
| Documentation | None | A template Verfahrensdokumentation to complete. |
| Privacy and imprint | None | Privacy and imprint links on the online receipt and events pages, plus a retention policy. |

## Suggested order

1. ~~Store VAT on each sale.~~ Done.
2. ~~TSE signing with outage handling~~ done; the Swissbit driver remains (see `tse-swissbit.md`).
3. ~~Receipt TSE block and QR, receipt numbers, cancellation receipts~~ done.
4. Add daily closings and cash movements.
5. Build the DSFinV-K export.
6. Add till registration data and the documentation template.

Steps 1-3 are needed before selling at a German convention. Steps 4-5 are needed for a tax inspection (Kassennachschau / Außenprüfung).

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
