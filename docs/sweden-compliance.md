# Selling in Sweden: legal compliance for Zollify

Status: 18 October 2026, from Skatteverket's published rules, the Swedish VAT Act (mervärdesskattelagen 2023:200) and Skatteverket's regulations on cash registers (SKVFS 2014:9 as amended). This is not tax or legal advice. Confirm the VAT points, the kassaregister position and the self-billing wording with a Swedish accountant (redovisningskonsult) before relying on them.

## Short answer

Two things decide what a Swedish artist or store can do with Zollify:

- **The kassaregister rule.** A business that takes cash or card payments must use a **certified cash register** (tillverkardeklarerat kassaregister with a certified **control unit**, kontrollenhet) and register it with Skatteverket, unless its cash-and-card sales stay under **four price base amounts a year** (4 × SEK 59,200 = **SEK 236,800 in 2026**, VAT included; 4 × 58,800 = SEK 235,200 in 2025). Card, Swish and every other electronic payment count as cash for this rule. Market and fair trade (torg- och marknadshandel) has been covered since 2014. Hobby activity is not. Skatteverket can grant an individual exemption (form SKV 1510) when the duty would be unreasonable; selling outdoors or without power is not reason enough. **Zollify is not a certified kassaregister and has no control unit.** Under the line it can be the till; above it the seller needs a certified register, and Zollify's role is stock, consignment and books.
- **VAT.** Sweden has 25 % standard, 12 % and 6 % reduced; art prints and books are 6 %. A business with turnover under **SEK 120,000** a year (2025 limit, this and the two previous years) can stay outside VAT; an **artist selling their own works** can stay outside VAT up to a taxable base of **SEK 300,000** a year, and above it charges **12 %** on all of them from the first krona. Both are in Zollify's VAT settings as exemptions; the 12 % artwork rate is not a product rate yet (see the gaps).

Everything else - the tax calendar, receipts, self-billing statements - is covered below with what Zollify does today.

## Tax calendar (now in Zollify: Settings → Tax deadlines, country Sweden)

Dates move to the next weekday when they fall on a Saturday, Sunday, public holiday, midsummer eve, Christmas Eve or New Year's Eve (lag 1930:173 om beräkning av lagstadgad tid, 2 §).

| What | When | Zollify |
|---|---|---|
| VAT return (momsdeklaration), taxable base up to SEK 40 million | Quarterly (the default) or monthly on request: the **12th of the second month** after the period, the **17th in January and August**. Q1 → 12 May, Q2 → 17 Aug, Q3 → 12 Nov, Q4 → 12 Feb | `se.vat-return` |
| VAT return, taxable base over SEK 40 million | Monthly, the **26th of the next month** (27 December) | `se.vat-return` with "over SEK 40 million" ticked |
| Yearly VAT return (helår), taxable base up to SEK 1 million | **26 February** with any EU purchase or sale; otherwise with the income tax return: **12 May** for a sole trader, 1 July (1 August electronically) for a company with a calendar year | `se.vat-annual` |
| Income tax return | Sole trader: **Inkomstdeklaration 1** with the NE appendix, **2 May**. Company: **Inkomstdeklaration 2**, 1 July on paper, 1 August electronically (calendar year) | `se.income-tax-return` |
| Debited preliminary tax (F-skatt) | Monthly into the tax account, the **12th**, the **17th in January and August** | `se.preliminary-tax` |
| EC Sales List (periodisk sammanställning) | The **25th** after the month or quarter electronically (the 20th on paper); monthly for goods, quarterly for services only; nothing to file when nothing was sold | `se.ec-sales-list` |
| EU SME scheme quarterly report (EX number) | Within a month of the quarter's end, to Skatteverket | `eu.sme-report` (the report itself is still missing, see gaps) |

Companies with a fiscal year other than the calendar year have their own dates (Skatteverket's "Viktiga datum"); Zollify assumes a calendar year.

## Receipts (kassakvitto)

Under the kassaregister rules a receipt must be produced and **offered to the customer** for every sale, and must show (SKVFS 2014:9, 7 kap. 1 §): the business name and **organisationsnummer** (or personnummer), the **address of the place of sale**, date and time, a **receipt number from an unbroken ascending series**, the **register's designation** (kassabeteckning), the goods with quantities and prices including VAT, the total, the **VAT amount and its split per rate**, the **payment method**, the control unit's serial number, and "elektroniskt kassakvitto" when electronic. The VAT items fall away for a seller with no VAT liability.

Zollify's receipt has the name, address, date and time, a sequential number per till (the till's series doubles as the register designation), the lines and prices, the VAT split per rate and the payment method, and the online receipt is marked electronic. What it lacks for Sweden is below.

## Artist statements (self-billing, självfakturering)

A store that writes the artist's invoice for them is self-billing. Sweden (ML 17 kap.) requires: an **agreement in advance** and a procedure by which the artist **approves each invoice** (taking it into their books is enough), the word **"Självfakturering"** on the document, the **same contents as an ordinary invoice**, and a **separate running number series for each seller** (artist). The seller remains responsible for the invoice. Payments for goods sold on consignment are not payments for work, so the artist's F-skatt status does not change what the store withholds.

Zollify records the self-billing agreement date per artist, issues numbered statements with the artist's VAT status and tax number, and never rewrites an issued one. The marking and the per-artist series are missing (below).

## What Zollify has, and what is missing

| # | Change | Status today | Why |
|---|--------|--------------|-----|
| S1 | **Tax calendar for Sweden** | Done in this change: VAT returns by filer size, yearly return, income tax, preliminary tax, EC Sales List, Swedish holidays and the eves | Skatteverket's dates |
| S2 | **Say plainly that Zollify is not a certified kassaregister**, with the four-price-base-amount line | The tax-deadlines setup says it for Sweden; nothing in the VAT settings or the sales pitch does | Kassaregisterlagen; a seller above the line must not use Zollify as the till |
| S3 | **Organisationsnummer on the receipt** for a seller who is exempt from VAT | The receipt prints the VAT number (SE + organisationsnummer + 01) only on a taxable sale; an exempt sale prints no number at all | SKVFS 2014:9 7 kap. 1 § a |
| S4 | **Place of sale on the receipt** | The seller's own address prints; the event's venue (where the sale was made) does not | SKVFS 2014:9 7 kap. 1 § b |
| S5 | **"Självfakturering" on artist statements** when the store is Swedish, and a **number series per artist** | One series per account (`SB-2026-0001…`), no marking | ML 17 kap. 15 and 24 §§ |
| S6 | **12 % rate for an artist's own original works** once over SEK 300,000 | Products take the country's first reduced rate (6 %, prints) or the standard rate; no second reduced rate per product | ML; only matters for registered artists selling originals |
| S7 | **SME scheme quarterly report** (turnover per EU country) | Reminder exists, report does not - every country | EU SME scheme (from 2025) |
| S8 | **Momsreg.nr label and SEK** | Done already: `Momsreg.nr`, SEK, Swedish as the language | - |

S2 and S3 are small and worth doing first; S5 matters for any Swedish consignment store; S4 and S6 are refinements; S7 is the open item from the German work as well.

## Sources

- Skatteverket, [Periodisk sammanställning för varor och tjänster](https://skatteverket.se/foretag/moms/deklareramoms/periodisksammanstallning.4.58d555751259e4d661680001093.html) (the 25th electronically, the 20th on paper, monthly for goods)
- Skatteverket, [Momssatser och undantag från moms](https://skatteverket.se/foretag/moms/saljavarorochtjanster/momssatserochundantagfranmoms) (the artist's SEK 300,000 and 12 %)
- Skatteverket, [I vissa fall behöver du inte registrera ditt företag för moms](https://skatteverket.se/momsbefrielse) (the SEK 120,000 exemption and its EU use)
- Skatteverket, [Så här anmäler du kassaregister](https://skatteverket.se/foretag/drivaforetag/kassaregister/saharanmalerdukassaregister) and [SKV 609, Försäljning på torg och marknad](https://www.skatteverket.se/download/18.15532c7b1442f256baef298/1708607409911/60901.pdf) (who needs a register, the four price base amounts, card as cash)
- Skatteverket, [SKVFS 2014:9 on cash registers](https://lagen.nu/skvfs/2014:9), 7 kap. 1 § (receipt contents)
- Skatteverket, [Momslagens regler om fakturering](https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/momslagensregleromfakturering) and FAR, [Självfaktura](https://www.faronline.se/dokument/rm_sjalvfaktura/) (self-billing)
- FAR, [Deklarationsdatum (moms)](https://www.faronline.se/dokument/rm_deklarationsdatum/) and Företagarna, [Viktiga deklarationsdatum för företag](https://www.foretagarna.se/driva-eget-foretag/deklaration-och-bokslut/viktiga-deklarationsdatum-for-foretag/) (VAT and income tax dates)
- Riksdagen, [Lag (1930:173) om beräkning av lagstadgad tid](https://lagen.nu/1930:173) (deadlines on weekends, holidays and the eves)
- Regeringen, [Prisbasbelopp för 2026 fastställt](https://regeringen.se/pressmeddelanden/2025/09/prisbasbelopp-for-2026-faststallt/) (SEK 59,200)
