# Selling in Denmark: legal compliance for Zollify

Status: October 2026. This is not tax or legal advice. The points about Skat's register rules and about consignment VAT should be confirmed with a Danish accountant (revisor) before relying on them.

## Short answer

Zollify does not need certification to be used in Denmark, and for artists and art shops the strict Skat till regime most likely does not apply. Four things still matter:

1. **Bookkeeping**: sales must reach a registered bookkeeping system, and the till data must be kept for the retention period.
2. **Receipts and invoices**: required content and gap-free numbering.
3. **GDPR**: Zollify holds customer, staff and participant data.
4. **Payments**: no surcharge on consumer cards.

## What applies

### 1. Bookkeeping Act (bogføringsloven)

- Businesses must keep their books in a **registered digital bookkeeping system** (registreret digitalt bogføringssystem), or in an individual system (individuelt system) that meets the same requirements.
- A till is **not** a bookkeeping system as long as its sales flow into a registered one. Zollify should not be marketed as a bookkeeping system.
- Retention is **5 years**. Till receipts in retail only need to be kept for 1 year if the daily totals are booked.
- Individual systems must have a weekly backup held by a third party in the EU/EEA, records that cannot be changed, and a user id on every entry.

### 2. Skat's rules for sales registration (digital salgsregistrering)

- From 2026 a register with a signed journal is required for **cafés, restaurants, pizzerias and grocery stores under DKK 10 million in revenue**, or where Skat orders it (påbud).
- Requirements for those businesses: a journal signed with **OCES3**, export as **SAF-T Cash Register**, X and Z reports. There is no certification scheme.
- Artists and art shops are **not** in the named sectors. Unless Skat issues an order, this regime does not apply to them.

### 3. VAT (moms)

- Standard rate **25%**. VAT registration from **DKK 50,000** turnover.
- Artists selling their **own works** have a higher threshold of DKK 300,000, and may pay VAT on a basis of 20% of the price.
- **Consignment**: a store selling on commission in its own name (kommissionssalg) charges VAT on the **full price**, not only its commission.
- Payout statements the store writes for an artist can count as self-billing (selvfakturering). That needs a written agreement with the artist.

### 4. Receipts and invoices

- A **full invoice** needs: date, sequential number, the seller's CVR number, both parties' names and addresses, what was sold, net price, VAT rate and VAT amount.
- A **simplified invoice** is allowed under **DKK 3,000** including VAT.
- Numbers must run **without gaps**.

### 5. E-invoicing

- Invoices to public bodies go through **NemHandel** (OIOUBL or Peppol BIS).
- There is **no B2B e-invoicing mandate** yet. The EU's ViDA package brings one for cross-border sales from 2030.
- Zollify's Peppol module (built for Belgium) already produces Peppol BIS 3.0, which NemHandel accepts.

### 6. GDPR (enforced by Datatilsynet)

- Hosting for other businesses needs a **data processing agreement** (databehandleraftale).
- Webhooks to US services (Discord, Slack) should **not** carry personal data.
- Report a breach within **72 hours**.
- Email marketing needs **opt-in consent**.

### 7. Payments

- Surcharges on **consumer cards** are banned (betalingsloven).
- **MobilePay** is the dominant phone payment; offer it as a payment method.

### 8. Accessibility (European Accessibility Act, in force since June 2025)

- **Microenterprises** (fewer than 10 people and under EUR 2 million turnover) are exempt as service providers.
- Public pages (shop, sign-up, receipts) should still aim for **WCAG 2.1 AA**.

## Gaps in Zollify, by priority

| # | Gap | Why |
|---|-----|-----|
| 1 | Append-only log with a user id on every entry, exportable | Bookkeeping Act. The op log is close; it needs an export and a stated guarantee. |
| 2 | Z report (daily totals) export to Danish bookkeeping systems (e-conomic, Dinero, Billy) | Lets sales reach the registered system. |
| 3 | Off-site backup in the EU/EEA, at least weekly | Individual-system rule, and plain good practice. |
| 4 | Receipt numbering without gaps, and receipt content per section 4 | Invoice rules. |
| 5 | A consignment setting: commission sale (VAT on the full price) or agency | Consignment VAT. |
| 6 | Data processing agreement template, no personal data in webhooks, retention settings | GDPR. |
| 7 | A written position: "not covered by digital salgsregistrering unless ordered" | So users know where they stand. |
| 8 | No card surcharge for Danish accounts, MobilePay as a payment method | Payments Act. |
| 9 | WCAG AA review of the public pages | Accessibility. |
