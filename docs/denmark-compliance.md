# Selling in Denmark: legal compliance for Zollify

Status: 16 October 2026, checked against Skat's own technical material (digital signature guideline v1.5.2, April 2025; supplier FAQ, July 2025; SAF-T Cash Register technical description v1.5.3). This is not tax or legal advice. Confirm the VAT points and the retention rules with a Danish accountant (revisor) before relying on them.

## Short answer

Zollify can be supplied to Danish businesses without any certification, because Denmark has none. Two regimes matter, and which one a customer falls under decides the work:

- **Every Danish business**: bookkeeping act, VAT invoice rules, 5-year retention, GDPR, the payments act. Zollify is close; the gaps are listed under *Tier A*.
- **Businesses under Skat's cash register rules (digital salgsregistreringssystem, momsbekendtgørelsen § 63-64)**: only four sectors, with turnover under DKK 10 million, since 1 January 2024 - cafés/pubs/discos, pizzerias/grill bars/ice cream bars, grocers and 24-hour kiosks, restaurants - or any business Skat orders to (påbud). For them the till must keep a signed electronic journal, export SAF-T Cash Register XML and produce X/Z reports. Zollify does not do this today. That is *Tier B*: several weeks of work plus an auditor's declaration.

A consignment or shelf-rental shop (reolbutik) is in neither of the four sectors. Skat says the real activity decides, not the registered branch code, so a shop whose main activity is a café would be covered. Unless a customer is in those sectors or receives an order, Tier A is what Zollify needs.

## What applies to every Danish business

### 1. Bookkeeping act (bogføringsloven, 2022)

- Books must be kept in a **registered digital bookkeeping system** (Erhvervsstyrelsen keeps the list; e-conomic, Dinero and Billy are on it) or in an own system that meets the same requirements: continuous recording with a voucher per entry, 5-year safekeeping, automatic backup in the EU/EEA, access control, SAF-T export on request, e-invoicing.
- A till is **not** the bookkeeping system as long as its sales reach a registered one. Zollify's e-conomic module books each day's sales as one voucher, which is the normal way a till feeds the books. Zollify must not be marketed as a bookkeeping system.
- Retention: **5 years from the end of the financial year** the record belongs to. Zollify's sales log is the underlying documentation for the daily voucher, so it must stay available that long. Till receipts in retail may be kept for one year only when the daily cash-up is booked - confirm with the revisor whether that applies to the electronic log as well.
- Timeline: companies in accounting classes B-D since July 2024; sole traders and associations with turnover over DKK 300,000 from the first financial year starting after 1 January 2026. A reported deferral of the provider-side requirements to 1 March 2027 could not be verified against Erhvervsstyrelsen.

### 2. VAT (moms)

- Standard rate **25 %**, no reduced rate. Registration from DKK 50,000 turnover.
- **Consignment**: a store selling in its own name under a commission agreement makes two supplies for VAT (artist to store, store to customer - momsloven § 4 stk. 3 nr. 1). The store charges 25 % on the **full price**, not on its commission. Zollify's till already does this: the store is the seller on every receipt.
- **Shelf and space rent is taxable.** Skat ruled that stall rent at a flea market is not exempt letting of property, because what the renter buys is the chance to sell to third parties; the same reasoning covers shelf rent. Charge 25 % on rent, including rent taken at the till (the Rent tile). Do not treat it as exempt property letting without a binding ruling.
- Artists selling **their own works**: VAT registration only above DKK 300,000, and VAT on a reduced basis (20 % of the price). This concerns the artist's own invoicing, not the store's till.
- **Artist payout statements** are self-billing (afregningsbilag): they need a written agreement with the artist, sequential numbers, both parties' CVR numbers, and no VAT line when the artist is not VAT-registered.

### 3. Receipts and invoices (momsbekendtgørelsen § 58 and § 64)

- A **simplified invoice** (till receipt) is allowed for sales under **DKK 3,000** including VAT and must show: date, a **sequential number**, the seller's name and **CVR number**, what was sold, the amount including VAT, and the VAT amount or a note that VAT is included. The number may run in series (per till, per financial year) but must have **no gaps**.
- Above DKK 3,000, or whenever a business customer asks, a **full invoice**: also the buyer's name and address, net amount, VAT rate and VAT amount.
- The receipt must be offered on paper unless the customer agrees to an electronic one. Zollify's QR receipt counts as electronic; keep a print path for customers who want paper.

### 4. GDPR (Datatilsynet)

- Hosting for other businesses needs a **data processing agreement** (databehandleraftale) and hosting in the EU/EEA (or another lawful transfer basis).
- Personal data must not go to US services without a basis. The feedback webhook already sends only message, screen and version to Discord.
- Breach notification within 72 hours; marketing email needs opt-in.

### 5. Payments (betalingsloven)

- Shops must **accept cash** (§ 81, with exceptions for late hours and unattended sales). Zollify has cash as a payment method.
- **No surcharge on consumer cards.** Zollify has no consumer surcharge; the card-cost pass-through goes to artists, not customers.
- MobilePay is the usual phone payment; it should be a selectable payment method.

### 6. Accessibility

- The European Accessibility Act exempts microenterprises as service providers. Public pages (shop, sign-up, online receipt) should still aim for WCAG 2.1 AA.

## Skat's cash register rules (Tier B) - what they demand

Source: momsbekendtgørelsen § 63-64 (BEK 2246 of 30 November 2021, renumbered since), Skat's supplier material.

- **Who**: the four sectors above with turnover under DKK 10 million, since 1 January 2024, plus any business Skat orders to use one (possible since July 2021 after irregularities). Fines on inspection: DKK 10,000 / 20,000 / 30,000 for the first, second and third visit, and daily fines of at least DKK 1,000 until fixed.
- **No certification.** Skat does not test or approve systems and says it never will. A supplier may have an auditor issue an **ISAE 3000 declaration** on Skat's DSRS template; that is the only proof customers can ask for.
- **The fifteen requirements**, in short:
  1. Every action logged in an **electronic journal**; transaction data **signed** with a Danish **OCES3** organisation certificate (VOCES), held by the business *or* its system supplier - only one of the two.
  2. Journal holds the receipt data plus the CVR number, a **unique sequential transaction number per CVR that is never reset** (distinct from the receipt number, which may run in series), start and end time, payment method, and the register's serial number.
  3. Export of the journal as **SAF-T Cash Register XML** (Danish format v1.5.3, UTF-8, file name `SAF-T Cash Register_<CVR>_<yyyymmddhhmmss>_<n>_<of>.xml`), produced by the system itself - no third-party converter.
  4. Transfer on request by encrypted mail, skat.dk, or common media.
  5. **Z report** (day's totals, resets counters) and 6. **X report** (since last Z). Z totals must reconcile with the transactions in the file.
  7. Card, MobilePay and other electronic payments are recorded **automatically** by the register.
  8. Totals per payment method.
  9. Built-in clock on **Danish standard time**, every time change logged.
  10. Receipt printer, unless the customer accepts electronic receipts.
  11. Receipts on demand that distinguish positive and negative amounts.
  12. Sales per employee, distinguishable across several tills; one combined journal per business.
  13. Training or test receipts clearly marked **not valid**.
  14. A cash drawer and a float for cash sales.
  15. No feature that adds, edits or deletes journal data, and no link to software or hardware that can.
- **Signature scheme** (guideline v1.5.2): RSA 3072 with SHA-512, PKCS#1 v1.5 (PSS accepted), signed **at the moment the sale completes - not in a batch, not at export**. The signed string is `previous_signature;nr;transID;transType;transDate;transTime;empID;transAmntIn;transAmntEx;registerID;companyIdent`, chained per register, `0` for the first. Signature, key version and the full certificate go in the XML. Private key must be the supplier's "unique knowledge", stored and protected by the supplier; compromise must be reported.
- **Offline**: no legal requirement to be online, but duplicates of the transaction number during short outages are tolerated; gaps are not. If a till runs offline without a cloud link, Skat recommends the **business's own certificate in the POS**. A cloud POS that signs on the server cannot complete a sale offline - that is a product decision for Danish Tier B customers.
- **Online sales** (own web shop, Wolt, Just Eat) must be recorded in the same journal.
- Data kept at least **5 years from the end of the financial year**.

## What Zollify has, and what is missing

### Tier A - needed for any Danish customer (consignment shops included)

| # | Change | Status today | Why |
|---|--------|--------------|-----|
| A1 | **Sequential, gap-free receipt numbers** per account (series per till allowed, reset per financial year allowed), on the printed and the online receipt | **Done** (#78): one gap-free series per till, on paper and online receipts | § 64 simplified invoice. Required for every Danish business, not only Tier B |
| A2 | **Receipt content check for DK**: CVR number as "CVR", seller name and address, VAT amount shown; a full-invoice path (buyer name and address) for sales over DKK 3,000 or on request | **Partly done**: the seller's tax number is labelled "CVR" for Danish sellers (#80), name, address and VAT amount print. **Open**: a full invoice from a sale with the buyer's name and address | § 58 / § 64 |
| A3 | **Retention guarantee**: no deletion of sales for 5 years after the financial year; account deletion must export the sales log first (or refuse while records are inside the period) | **Done** (#79): sales are kept for 10 years (`SALES_RETENTION_YEARS`); an account with sales inside the period cannot be deleted outright. The online receipt link still stops after `RECEIPT_TTL_DAYS` (400), which is fine | Bookkeeping act, momsbekendtgørelsen |
| A4 | **e-conomic**: book shelf/space rent to its own income account at 25 %, and VAT codes for the 25 % rate on sales | **Done** (#79): rent books to its own account | Bookkeeping act, VAT on rent |
| A5 | **Self-billing statements**: written self-billing agreement with each artist (a checkbox and a stored text), both CVR numbers, no VAT line for unregistered artists | **Done** (#81): each artist carries a tax number, VAT-registered yes/no and the date the self-billing agreement was made; statements and the journal export show them, and an unregistered artist gets no VAT line | § 58 self-billing |
| A6 | **Data processing agreement** template and a statement of hosting location | Hosting in Frankfurt, Germany (EU) is stated (#77). **Open**: the DPA text itself | GDPR |
| A7 | **MobilePay** offered as a ready-made payment method for Danish accounts | **In review** (#82): MobilePay by QR code from the till | Market expectation; cash acceptance is already there |
| A8 | **Cash up (kasseafstemning)**: a daily cash count per store that books the difference, so the daily voucher matches the drawer | **Open**: the cash-up view exists per event, but the count is not tied to the e-conomic voucher | Bookkeeping act "daily cash reconciliation" |

Still open after #78-#81: the full-invoice path in A2, the DPA text in A6, the cash-up booking in A8, and MobilePay once #82 lands. None of them stops a Danish consignment shop from using Zollify today; a revisor would ask for A2 the first time a customer wants a proper invoice.

### Tier B - only for the four sectors or on Skat's order

| # | Change | Status today | Effort |
|---|--------|--------------|--------|
| B1 | **Electronic journal of all actions**: sign-in, drawer open, void, price look-up, training on/off, clock change, X/Z runs, with employee id - beyond the sales log | Sales, reverts and `soldBy` are logged; the rest is not | Medium |
| B2 | **Per-CVR transaction counter that never resets**, assigned at sale completion; tolerated duplicates offline, never gaps | UUIDs | Small, but needs a design for offline tills |
| B3 | **RSA-SHA512-3072 chained signature per sale at completion**, OCES3 VOCES certificate held by Zollify (supplier) or the shop, key version recorded; signing must happen where the sale completes | None | Medium; the hard part is offline: either sales wait for the server to sign (online-only mode for DK Tier B tills) or the shop's own certificate is installed on the device |
| B4 | **SAF-T Cash Register XML export** v1.5.3 for a period: company, employees, articles, VAT codes, basics, locations, registers, events, Z/X eventReports, cashtransactions with ctLines, signatures | None (Zollify has no SAF-T at all) | Large: the format has ~100 pages of elements. Validate with Skat's XSD and script (`ufst-xml-validation`) |
| B5 | **X and Z reports** per till per day, with totals per payment method, per VAT rate, per employee, returns, pay-ins/outs, and a receipt count | Daily totals exist in reports, not as a Z that resets counters and is itself journaled | Medium |
| B6 | **Training mode receipts marked "not valid"**; test sales still written to the journal as training | Test mode sells into a test event: each test sale is recorded and synced as a test (`tx.test.*`), numbered in its own TEST series and marked "TEST - NOT A RECEIPT" on paper and online. Missing: "Clear test data" removes them, which a training journal must not allow | Small: keep cleared test sales in the journal |
| B7 | **Danish standard time clock** with every adjustment logged; refuse sales when the device clock is off from the server by more than a tolerance | Device clock, store time zone setting for books | Small |
| B8 | **No edit/delete path** for journal data, documented; staff deny list already blocks module toggles | Mostly true; needs a written guarantee | Text |
| B9 | **ISAE 3000 declaration** by a Danish auditor on Skat's DSRS template | None | External cost, after B1-B8 |

Rough size of Tier B: three to five developer-weeks plus the auditor. It also commits Zollify to holding an OCES3 certificate (ordered through MitID Erhverv, which needs a Danish CVR or an eIDAS alternative agreed with Skat at digital.salg@sktst.dk) and to key custody obligations.

## Recommendation

1. Finish Tier A: the full-invoice path (A2), the DPA text (A6) and cash-up booking (A8). The receipt numbering a revisor flags first (A1) is done.
2. State in the product and the sales pitch: "Not a digital salgsregistreringssystem under momsbekendtgørelsen § 63. Suitable for shops outside the four named sectors. Cafés, restaurants, grocers and kiosks need a Tier B till." This keeps the prospect honest about a shop that also runs a café as its main activity.
3. Build Tier B only against a paying customer in one of the four sectors, and decide the offline question first (online-only signing is the cheapest honest answer).

## Sources

- Skat, [New requirements for electronic sales registration systems for certain sectors in 2024](https://skat.dk/en-us/businesses/new-requirements-for-electronic-sales-registration-systems-for-certain-sectors-in-2024) (sectors, the fifteen requirements, fines)
- Skat, [For suppliers of digital sales registration systems](https://skat.dk/erhverv/nye-krav-til-digital-salgsregistrering-for-visse-brancher-i-2024/for-leverandoerer-system-til-digital-salgsregistrering) (ISAE 3000 template, SAF-T documents, validation script, OCES3)
- Skat, [Guideline for implementing digital signature in digital cash registers v1.5.2](https://skat.dk/media/i4xilbvg/guideline-for-implementing-digital-signature-in-digital-cash-registers-v152.pdf)
- Skat, [FAQ for suppliers, July 2025](https://skat.dk/media/ixlo2nw3/2025-07-04-faq-leverandoerer.pdf) and [FAQ for businesses](https://skat.dk/media/2pwbntfe/2023-11-15-ofte-stillede-spoergsmaal-faq.pdf?id=153989) (transaction numbering, offline, certificate holder, retention, exchanges, Z totals)
- Skat, [Technical description, Danish SAF-T format for cash register data v1.5.3](https://skat.dk/media/wwpnsxp0/technical_description_danish-saf-t-format-for-cash-register-data-v153.pdf)
- Erhvervsstyrelsen, [Guide on bookkeeping and digital bookkeeping systems](https://danishbusinessauthority.dk/sites/default/files/2023-10/guide-bookkeeping-digital-bookkeeping-systems_danishbusinessauthority-april-2023_wa.pdf) and [Krav til digitale standard bogføringssystemer](https://erhvervsstyrelsen.dk/krav-til-digitale-standard-bogfoeringssystemer)
- PwC, [Værd at vide om det kommende krav til digitale kasseapparater](https://www.pwc.dk/da/services/sme/artikler/digitale-kasseapparater.html); Beierholm, [Påbud om salgsregistreringssystem for visse brancher](https://www.beierholm.dk/viden-og-indsigt/nyheder-og-artikler/paabud-om-salgsregistreringssystem-visse-brancher)
- Skat, [Moms ved kunstneres salg af egne værker](https://info.skat.dk/data.aspx?oid=150692); tax.dk, [Kommissionsaftaler (varer)](https://www.tax.dk/jv-2020-2/da/D_A_4_2_1.htm) and the flea-market stall rent ruling cited there
- lookuptax, [Denmark VAT guidelines (momsbekendtgørelsen § 58)](https://lookuptax.com/docs/country/denmark-vat-guidelines-momsloven); Grant Thornton, [New Bookkeeping Act](https://www.grantthornton.dk/en/insights/articles/new-bookkeeping-act/)
