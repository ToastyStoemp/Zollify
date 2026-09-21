# Filing with IAA-Plus (ATLAS-Ausfuhr Internet) — step by step

Built from an actual filing run, not documentation guesswork. Update this file
every time a step turns out different from what's written here.

## Before you start

- Have the export packing list and IAA-Plus filing sheet open (Customs
  (Germany) → the event → generate both).
- EORI number and precheck office (Hauptzollamt) should already be set once
  under Settings → Customs declarant (Germany), not typed fresh here.

## Steps confirmed so far

1. **Log in** via ELSTER certificate at the IAA-Plus login page.
2. **Niederlassungs-Nr.** (branch/site number) — tied to your EORI.
   - Single business location, no separate registered branches: enter `0000`
     (four zeros).
   - If `0000` is rejected too ("nicht vorhanden oder ungültig"), that's not a
     wrong-input problem — the EORI itself isn't linked to an ATLAS
     participant record yet. Contact the Zoll Servicedesk to get that fixed;
     no amount of retrying different numbers here will help.
3. **Start page** after login: "Willkommen, [name]". Left/top nav has
   "Startseite", "Niederlassungsnummer wechseln", "Impressum". A "Dokumente"
   section links out to official guides (Verfahrensanweisung, Merkblatt für
   Teilnehmer, Merkblatt zu Zollanmeldungen, **Leitfaden**) - these live on
   www.zoll.de, not on this page itself. Go read the Leitfaden before
   filling in a real declaration; it's the actual authoritative walkthrough.
4. Left sidebar tree on the start page: **Ausfuhrzollstelle** (export customs
   office side) → **Ausfuhranmeldung** (export declaration) →
   "... Normalverfahren, Vereinfachte Verfahren, einstufige Verfahren" is the
   entry point for a new declaration. The first click opens a status/overview
   stub (MRN, LRN, Ausfuhrzollstelle - all blank); clicking "Ausfuhranmeldung"
   in the left tree opens the real data-entry form, **Kopfseite 1**.
5. **Kopfseite 1**. One real choice here:
   - **Art der Anmeldung** (dropdown, required): two options, `CO` and `EX`.
     `EX - Ausfuhr oder Wiederausfuhr von Gütern außerhalb des Zollgebiets der
     Union` is correct for exporting to a non-EU country like Switzerland.
     `CO` is for trade between EU special fiscal territories - not this case.
     The tooltip on the field confirms this reading.
   - **Art der Ausfuhranmeldung**: prefilled `00000100 -
     Standard-Ausfuhranmeldung zum zweistufigen Normalverfahren` (standard
     two-step normal procedure). Left as the default - matches "export now,
     confirm exit later" which is our case.
   - **UI quirk**: the dropdown is a custom combobox, not a native `<select>`.
     Clicking a visible row can select the wrong one if the mouse is hovering
     a different row than the one you're looking at (the *hovered* row is
     what gets picked, not necessarily the one under the cursor at click
     time as rendered). Move the mouse onto the exact row first, take a
     screenshot to confirm the highlight, then click. Typing text into the
     box does filter it but pressing Enter can also grab the wrong
     highlighted row - safest is mouse-hover-then-click.
   - The pink background on required fields is just styling ("Pflichtfeld"),
     not an error state - don't mistake it for validation failure.
6. **Kopfseite 2** - this is where most of the real boxes live:
   - **Bestimmungsland** (destination country, required) = box 17a.
   - **Ausfuhrland** = box 15a, prefilled `DE`.
   - **Ausfuhrzollstelle** (required) - the export customs office itself.
   - **Ausgangszollstelle** (required) = box 29, office of exit. Confirmed
     separate from Ausfuhrzollstelle, as this module already modeled.
   - **Sicherheit** (required dropdown) - security/guarantee type. Not yet
     confirmed which option applies to a straightforward exhibition export.
   - **Gesamt-Rohmasse** (required, kg) = box 35 gross mass - entered once at
     **header level as a total**, not just per goods line. The packing
     list/IAA-Plus sheet this module generates already totals this - use
     that number directly.
   - **LRN** (required) - Local Reference Number, your own unique reference
     for this declaration. **This module currently treats "reference number"
     as optional (box 7) - that's wrong.** LRN here is mandatory and
     functions like customs-ch's auto-generated LRP. Needs fixing: either
     auto-generate one the same way, or make the field required with
     guidance (must be unique per declaration).
   - **Referenznummer/UCR** - conditionally required (Unique Consignment
     Reference), separate from LRN.
   - **Warenort** section (required): Art des Ortes, Art der
     Ortsbestimmung - where the goods physically are. Not yet explored.

## Ausgangszollstelle - resolved

Your CH-side crossing point was "Zoll Nordost - Bargen (CH002311)" - a
**Swiss** office code, not usable directly in IAA-Plus's Ausgangszollstelle
field (which needs the German-side office for the same physical crossing).
Searching IAA-Plus's own list for "Bargen" or "Gottmadingen" found nothing -
small DE-CH crossings aren't always named the same on both sides.

Resolved by checking the Swiss customs "Search for an office" tool at
ezv.admin.ch, which led to **Hauptzollamt Singen** as the responsible German
office for that crossing. Searching "Singen" in IAA-Plus's Ausgangszollstelle
list gave two results - `DE004103 Rielasingen` (road) and `DE004105
Singen-Bahnhof` (rail station). Picked **Rielasingen**, matching road
transport. Set and confirmed.

Side note while on that Swiss tool: it also asks about **"Collective customs
procedure"** (Sammelzollverfahren) - a Swiss scheme for companies with a
standing authorization to declare multiple shipments together. Not
applicable without holding that authorization; picked "Import" under
"Commercial goods" instead. Also surfaced: **ATA Carnet** is the standard
international mechanism for temporary import of exhibition goods with
planned re-export - literally this use case - as an alternative to the
ZAVV process customs-ch already builds around. Not evaluated further, just
flagged as a real alternative worth a separate look, not a mid-flow switch.

## Warenort - self-correcting validation rule

The system itself flags invalid combinations before you even submit ("Aktuelle
Hinweise" panel): if **Art der Ortsbestimmung** = `U`, `W`, or `Z`, then
**Art des Ortes** must be `D` (Anderer Ort) - picking `A` (Bestimmter Ort)
there was wrong once "Adresse" (`Z`) was chosen for Ortsbestimmung. Trust
these hints over any guess made before reaching this page.

Fields used for Warenort in our case: Art des Ortes = `D`, Art der
Ortsbestimmung = `Z` (Adresse), then the real business address (street,
postcode, city, country) - no separate authorization needed for a plain
business address.

## Kopfseite 2 continued: Anmelder, Empfänger, Versender

Below Warenort, more Kopfseite 2 sections:

- Three pre-checked boxes confirm filing on our own account, no agent:
  "Anmelder ist Ausführer", "Außenwirtschaftlicher Ausführer ist
  (zollrechtlich) Ausführer" - both checked by default, correct for us.
  "Subunternehmer beauftragt" (subcontractor commissioned) unchecked, also
  correct.
- **Anmelder** (declarant) box shows a live, auto-filled **EORI:
  `DE607109170504586`** and **Niederlassungsnr: `0000`**, pulled from the
  actual logged-in IAA-Plus account - not something we typed. This is the
  real verified EORI. **Action: update this module's Settings → Customs
  declarant (Germany) → EORI field to this real value**, replacing whatever
  placeholder is there now.
- Anmelder → Ansprechpartner (contact person): Name\* and Telefon\* required.
  Name known (declarant), phone not on file in the booth profile - open.
- **Empfänger** (recipient) and **Versender** (consignor) live here at
  header level, confirmed correct placement per the official help text:
  "Der Empfänger muss bei nur einem Empfänger auf Kopfebene ... angegeben
  werden" (recipient goes at header level when there's only one - ours is
  one). Per-position Empfänger/Versender (seen earlier on the Warenposition
  page) is only for when different positions ship to different recipients -
  not our case.
- **Versender filled** with real data: Phuong Ninjin, Buckower Damm 83,
  12349 Berlin, DE.
- **Empfänger left open** - who receives the goods in Switzerland? Own booth
  care of the venue, or an actual event-organizer entity? Not guessed.
- **Beförderer** (carrier) box also present, greyed out - not yet explored
  whether/when it becomes required.

## Warenposition (the actual goods/packaging form)

Reached via the left tree once at least one goods line is required. Real
fields, mapped against what this module currently tracks:

- **Waren laden** (`...` button) - loads from a saved goods master record.
  Ties back to Stammdaten → "Waren anlegen/bearbeiten" seen earlier - goods
  entered there once can be reused per declaration instead of retyped. Not
  yet explored whether this module should export/import that format.
- **Warenbezeichnung*** (goods description, required) - our `title`.
- **Warennummer*** (commodity/tariff code, required) - our `tariffNo`. Has an
  "EZT-Ausfuhr" link next to it - the official electronic customs tariff
  lookup for exports. Use that to look up/verify a code, not a guess.
- **Rohmasse\*** (gross mass, kg, required) vs **Eigenmasse\*** (net mass, kg,
  required) - **two separate required weights per item.** This module only
  tracks one `weightG` per product. **Paused here** - need to know whether
  the recorded weight is the item alone (net) or item+packaging (gross)
  before this module can map to either field correctly, let alone both.
- **Statistischer Wert\*** (statistical value, EUR, required) - our per-item
  value.
- **Versendungsregion\*** (dispatch region, required dropdown) - a new
  concept, not in this module's model at all. Likely a fixed NUTS-style
  region code for Berlin, so probably a one-time constant like the precheck
  office - not yet looked up.
- **Ursprungsland\*** (country of origin, required) - our `originCountry`.
- Optional: CUS-Code (mainly for chemicals), TARIC-Zusatzcode table,
  Gefahrgut (dangerous goods) table, Referenznummer/UCR, Beförderungskosten
  (Zahlungsart).

## Weight: gross vs net, confirmed

Asked the team: recorded `weightG` per product is **with packaging**
(plastic wrapper on prints/keychains etc.) - so it maps directly to
**Rohmasse** (gross). No separate net-weight source exists, but for this
kind of light individual packaging the gross/net gap is negligible - using
gross for both (already what `iaa-plus-sheet.ts` does) is a reasonable call,
not a real gap. Would need revisiting only for a heavily-boxed product.

The reusable plastic storage bins used to transport stock between
conventions are **not** part of item weight or the goods themselves - they're
the exporter's own transport equipment, not customs goods. They don't touch
Rohmasse/Eigenmasse. They may matter for the Verpackung table below.

## Finding a field's real documentation

The "?" icon on a section header opens a *specific* help sub-topic (can land
you somewhere unrelated, e.g. clicking it on "Verfahren" opened an article
about a niche warehouse-termination scenario, not the field itself). For the
actual field-by-field reference: **Hilfe (top nav) → Volltextsuche tab →
search the field's German name**. For Positionsseite fields, the result
"Unterformular „Ausfuhranmeldung - Positionsseite"" is the real reference -
confirms every field's exact meaning, official wording, straight from Zoll.

That page confirmed, word for word:
- **Rohmasse** = "Masse der Ware mit ihrer Umschließung" (mass of the goods
  *with* their wrapping) = gross. **Eigenmasse** = "Masse der Ware ohne
  Verpackung" (mass *without* packaging) = net. Matches what we already
  concluded from the weight question above.
- **Verfahren** is still not a lookup with an obvious default - official
  text just says "die zollrechtliche Bestimmung ... zu der die Waren
  angemeldet werden" (the customs-legal destination the goods are declared
  under). No shortcut in the help text itself.

## Verfahren - strong candidate found, not yet confirmed with broker

Browsed the live 149-entry Verfahren list (not guessed from memory).
`21+xx` ("Vorübergehende Ausfuhr im Rahmen der PV") is outward processing -
repair/manufacturing sent abroad - wrong category, ruled out.

**`23+00` - "Vorübergehende Ausfuhr zum Zwecke der Wiedereinfuhr in
unverändertem Zustand · kein vorhergehendes Verfahren"** (temporary export
for the purpose of re-import unchanged, no previous procedure) matches this
exact scenario word for word: goods leave temporarily, unsold stock returns
unchanged. This is the standard code family for exhibitors/travelling
traders, not something invented for this case.

**Working value: `23+00`, set on the test declaration, until further
notice.** Team decision, not a broker/Amt confirmation - still flagged below
as unresolved. It's the one field with real legal/duty weight; a strong
textual match found in the official list is a much better starting point
than a guess, but "matches the description" and "confirmed correct for your
case" aren't the same thing.

(UI note: the Verfahren field is the same finicky hover-selects-the-wrong-row
combobox as Art der Anmeldung on Kopfseite 1 - typing text into it directly
picked `23+07+F61` by mistake once. Always reopen via the "..." search
button, search, and click the exact row in the resulting table - don't type
into the field itself and press through.)

**Real gap flagged during review**: `23+00`'s wording is "Wiedereinfuhr in
**unverändertem Zustand**" - re-import *unchanged* - read literally, the full
declared quantity comes back. Ours won't; some sells and stays in
Switzerland permanently. Standard practice for temporary-export regimes
worldwide (this is exactly what ATA Carnets are built around) is that
partial non-return is normal - the sold portion converts to a definitive
export at the point of sale, the rest re-imports as planned under the
temporary procedure.

**Exact question for the broker/Hauptzollamt**: does `23+00` handle partial
non-return automatically (the re-import declaration simply covers whatever
smaller quantity actually comes back), or does selling goods abroad under a
German temporary-export declaration require a separate follow-up
notification ("Umwandlung in endgültige Ausfuhr" / conversion to definitive
export) at the point of sale? This is exact ATLAS procedural mechanics with
no documentation seen yet - do not assume either answer.

## Verpackung: how shared packaging actually works (confirmed)

**Packstück-Verweis** "ist nur beschreibbar, wenn die Anzahl der Packstücke
mit dem Wert '0' angegeben wird" (only usable when that position's own
Anzahl = 0). This is the real mechanism for our shared boxes:

- The **first** Warenposition packed into a given box declares the real
  `Art` + `Anzahl` (e.g. keychains: `CS`, `Anzahl = 1`).
- Every **other** Warenposition sharing that same physical box declares
  `Anzahl = 0` and uses `Packstück-Verweis` to point at the position that
  owns the real count (e.g. enamel pins → `Anzahl = 0`, references the
  keychains position).

So for our 7 packages: each of the 6 distinct boxes gets its count declared
once, on whichever Warenposition is entered first for that box; every other
product type sharing that box references it at Anzahl 0 rather than
double-counting the same physical package.

## Verpackung (packaging) - per goods line, genuinely open

Below Empfänger/Versender/Lieferketten-Beteiligter/Geschäftsvorgang, each
Warenposition has a **Verpackung** table: `Art` (packaging type code,
required lookup), `Anzahl` (count), `Versandzeichen` (shipping marks),
`Packstück-Verweis` (package reference) - up to 99 rows per position.

**Answered.** The `Art` lookup is the standard UN/CEFACT Recommendation 21
packaging code list (406 entries, searchable). Confirmed codes:
- `CT` = Karton (cardboard box)
- `CS` = Kiste ("Case") - generic reusable case, material-agnostic; fits the
  reused plastic storage boxes

Real packaging breakdown for this booth, by product type, 7 packages total:

| Package | Art | Anzahl | Contents (product type) |
|---|---|---|---|
| 1 | `CT` | 1 | Art prints |
| 2 | `CS` | 2 | Sticker books |
| 3 | `CS` | 1 | Keychains + enamel pins |
| 4 | `CS` | 1 | Bear bags + bear wallets |
| 5 | `CS` | 1 | Hats |
| 6 | `?` | 1 | Sticker sheets - material not specified (cardboard or plastic not stated), confirm before filing |

Packaging is grouped **by product type**, not per SKU, and some distinct
types share one box (keychains+pins together, bear bags+wallets together) -
not a clean 1:1 with a single `type` field value. Multiple Warenpositionen
sharing a physical box would use the same **Packstück-Verweis** to link them.

This also confirms `totalPackages` in `CustomsDeMeta` (added earlier, default
1) is the right field - just needs setting to 7 for a real filing here,
rather than left at the default.

**Not building automatically yet** - grouping products into named packages
by type is real new modeling work (a type→package mapping doesn't exist in
`CustomsDeProduct` at all), and this booth's grouping is specific enough
(two categories merged into one box) that a generic "group by type" rule
wouldn't get it right anyway. Worth a manual field per product/type later if
this becomes a recurring need, not before.

## DEXPDF XML generator - built

The IHB was found and downloaded (see `ihb-reference/` in this module for the
extracted schema files). A real generator now exists:
[dexpdf-xml.ts](src/engine/dexpdf-xml.ts), built directly against
`DEXPDF.xsd`'s actual element names, fixed values, and structure - not
guessed. 14 tests in
[dexpdf-xml.test.ts](src/engine/__tests__/dexpdf-xml.test.ts) check the XML
is well-formed, that fixed/required fields match the schema's own regex
patterns, that Verfahren/tariff-splitting/escaping behave correctly, and that
missing required data (BIN, LRN, EORI, consignee) produces a warning instead
of a silently-broken message.

**Scope**: only the segments this module has real data for (envelope,
header, both customs offices, declarant, consignor/consignee, Warenort, and
one GoodsItem per claimed product with Procedure/Origin/Commodity/
GoodsMeasure/Packaging). Everything else in the schema - representatives,
subcontractors, warehousing, outward/inward processing, dangerous goods,
supporting documents, and more - is legitimately optional (`minOccurs="0"`)
and omitted rather than filled with invented values.

**Known gaps, returned as `warnings` from `buildDexpdfXml()`, not silently
papered over:**
- **MessageSender authenticationNumber (BIN)** - a required 25-digit
  credential, distinct from the EORI, that nothing seen so far (IAA-Plus UI,
  Settings, anywhere) has surfaced a source for. The message cannot be valid
  without it. Where this comes from is still an open question.
- **partyConstellation** defaults to `"0000"` - not decoded against ATLAS
  codelist A0127, so not confirmed correct for our actual Anmelder/
  Subunternehmer setup.
- **Packaging** is emitted as one generic `CS` per item - doesn't reflect the
  real 7-package breakdown (cardboard box for art prints, shared boxes via
  Packstück-Verweis) documented above. Model has no per-product packaging
  field yet.
- Still not validated against a live ATLAS test environment - structural
  correctness (does it parse, does it match the schema's shape) is tested;
  legal correctness of the values themselves is not.

**Not done**: wiring this into `DocumentsView.vue` with a button, and the
model additions it needed (`lrn`, `natureOfTransaction`, `security`,
`partyConstellation`, `messageSenderBin`, `consignee*` fields on
`CustomsDeMeta`) aren't yet exposed in the Settings/Documents UI - they exist
on the model with defaults, but nothing lets you edit them yet.

## Possible bigger win: XML upload instead of manual entry

Left nav → Ausfuhranmeldung → "... AM in die IAA-Plus laden" opens an upload
screen: "Anmeldungen im XML Format laden". Notes on it:
- Only Ausfuhranmeldungen (export declarations) can be uploaded.
- Must conform to the **AES XML format** ("AES" = Automated Export System,
  the EU-wide export declaration message standard).
- Two participant constellations are explicitly **not** supported:
  "Anmelder = Ausführer wird direkt vertreten" and "Anmelder <> Ausführer
  wird direkt vertreten" (declarant = exporter represented directly, and
  declarant ≠ exporter represented directly) - need to check which
  constellation applies to filing on our own account (probably fine, we're
  not a customs agent representing a third party, but not confirmed).
- Schema reference: "entnehmen Sie bitte dem IHB" - an "IHB" document defines
  the AES XML format. Not yet located or read.

**If** this module could generate a correct AES XML file, this upload path
would replace the whole manual box-by-box entry - a real step toward "the
tool actually fills the documents," which was the original ask. But this
needs the actual IHB schema doc found and verified before writing a single
line of XML-generation code - same rule as before, no guessing at a customs
message format. Find and read the IHB before attempting this.

## Open questions (superseded by the final checklist at the bottom of this file)

## How to find your Ausfuhrzollstelle (don't guess between similarly-named offices)

IAA-Plus's own office picker for "Ausfuhrzollstelle" showed 3 Berlin options
for a road shipment (Marzahn, Dreilinden, Messe) plus the airport - all
different physical offices, and nothing in IAA-Plus itself (checked
Stammdaten → Adressen/Bewilligungen/Waren/Warenort - no jurisdiction lookup
there) says which one is yours.

**Official way to find out**: zoll.de → search icon → "Dienststellensuche" →
choose "Ausfuhrzollstelle" → "Ihre zur Ausfuhr bestimmten Waren melden Sie
bitte bei der zuständigen Ausfuhrzollstelle an" → enter your business/loading
postcode. It returns the exact office and its Dienststellenschlüssel (code).

For postcode 12349 Berlin: **Hauptzollamt Berlin, Zollamt Dreilinden**,
Dienststellenschlüssel **2152** → matches `Berlin-Dreilinden (DE002152)` in
IAA-Plus's picker exactly.

**Fix for Settings**: "Hauptzollamt Berlin" alone isn't specific enough to
save in Customs declarant (Germany) settings - a Hauptzollamt has several
subordinate Zollämter and only one is correct. Save the specific office name
(e.g. "Zollamt Dreilinden") and code (2152) instead, found once via the
Dienststellensuche above.

## Tariff code lesson: check the specific subheading, not just the family

Started with `491199` (4911 "andere Drucke" → 4911 99 "andere" - the generic
catch-all). Wrong precision: `4911 91` ("Bilder, Bilddrucke und Fotografien"
- pictures, picture-prints, photographs) is the specific match for art
prints. Verified `4911910000` returns real TARIC measures (not a dead code).
**Lesson for the packing list / IAA-Plus sheet**: don't stop at the 4-digit
heading match, check whether a more specific subheading exists before
settling on "andere" (other) - "andere" is a catch-all, not a shrug.

## Beförderungskosten (Zahlungsart) - resolved

Options: Barzahlung, Kreditkartenzahlung, Zahlung mit Scheck, Andere (z.B.
Kontoabbuchung), Elektronischer Zahlungsverkehr, Konto beim Beförderer,
**Keine Vorauszahlung**. Picked the last one (`Z`) - we're driving the goods
ourselves, no paid carrier invoice exists for this leg.

## Geschäftsvorgang (nature of transaction) - open judgment call, lower stakes

21 standard EU trade-statistics codes. Two real candidates, not selected yet:
- `12` - Direkter Handel mit/durch private(n) Verbraucher(n) (direct trade
  with private consumers) - matches the sold portion: selling directly to
  attendees at the booth.
- `32` - Ansichts- oder Probesendungen, einschließlich Konsignationslager
  (goods sent on approval/trial, consignment-style) - matches the shipment's
  actual nature: sent out with sold-vs-returned undetermined at export time.

Lower stakes than Verfahren - this feeds trade statistics, not a legal
customs regime - but still a real classification choice, not picked blind.

## Fix needed in this module

- Add a proper **LRN** field (required, unique per declaration) to
  `CustomsDeMeta` and the IAA-Plus sheet - currently missing. Consider
  auto-generating it the way `computeLRP()` does for customs-ch.

## Master checklist - status as of this exploration session

The full IAA-Plus form (Kopfseite 1, Kopfseite 2, Warenposition) has now been
walked field by field with a real test declaration. Resolved:

| Field | Value | Confidence |
|---|---|---|
| Art der Anmeldung | `EX` | Confirmed (tooltip matches) |
| Art der Ausfuhranmeldung | `00000100` (default, two-step Normalverfahren) | Not independently re-verified, left as default |
| Bestimmungsland | `CH` | Confirmed |
| Ausfuhrland | `DE` | Confirmed (prefilled) |
| Ausfuhrzollstelle | `DE002152` Berlin-Dreilinden | Confirmed via official Dienststellensuche by postcode |
| Ausgangszollstelle | `DE004103` Rielasingen | Confirmed via Swiss office lookup → Hauptzollamt Singen → IAA-Plus search |
| Sicherheit | `0` (no summary declaration data) | Reasoned, not broker-confirmed |
| Warenort: Art des Ortes / Ortsbestimmung | `D` / `Z` (Adresse) | Confirmed by the system's own validation rule |
| Gesamt-Rohmasse, LRN, Referenznummer/UCR | not filled | Real per-shipment data, fill at actual filing time |
| Anmelder EORI | `DE607109170504586` | Real, auto-filled by IAA-Plus - **update module Settings to match** |
| Niederlassungsnr | `0000` | Confirmed |
| Anmelder → Ansprechpartner (contact) | Name known, **phone open** | Waiting on you |
| Empfänger (recipient, CH) | **not filled** | Waiting on you - who receives the goods? |
| Versender (sender) | Phuong Ninjin, Buckower Damm 83, 12349 Berlin, DE | Filled, real data |
| Warenbezeichnung / Warennummer (test item: art print) | `4911910000` | Confirmed via EZT-Ausfuhr, corrected from an initial wrong-precision guess |
| Rohmasse / Eigenmasse | Gross = your recorded `weightG` (has packaging); net not tracked, gross≈net acceptable for light packaging | Confirmed with you |
| Statistischer Wert | per-item value | Straightforward once real data used |
| Versendungsregion | `11` Berlin | Confirmed (fixed constant) |
| Ursprungsland | `DE` | Confirmed |
| Beförderungskosten (Zahlungsart) | `Z` Keine Vorauszahlung | Reasoned (self-transport, no carrier invoice) |
| Geschäftsvorgang | `12` or `32` | **Open judgment call**, lower stakes |
| Verpackung | 7 packages total, `CT`/`CS` codes, shared-box mechanism via Packstück-Verweis | Confirmed, one item's material (sticker sheets) still unspecified |
| Verfahren | `23+00` | **Working value only** - the partial-non-return mechanic is unconfirmed, real question logged above |

**Resolved with the team:**
1. **Empfänger** = self, care of the event venue (not a separate organiser
   entity). For Zurich Pop Con specifically: the event has no address saved
   in Boothly yet, so used a real placeholder venue - Messe Zürich,
   Wallisellenstrasse 49, 8050 Zürich, CH. **Fill in the event's real venue
   address in Boothly**, then use that instead of this placeholder.
2. **Anmelder contact phone**: mock German number `+49 30 12345678` used for
   testing. Replace with a real number before any real filing - IAA-Plus
   will presumably want to actually reach this number.
3. **Geschäftsvorgang = `32`** (Ansichts-/Probesendungen, consignment-style) -
   chosen for consistency with Verfahren `23+00`'s framing: sent out with
   sold-vs-returned undetermined at export time. `12` was the alternative,
   not used.
4. **Sticker sheets packaging = `CS`** (plastic case) - vinyl stickers are
   light like the other items already boxed in reused plastic bins; only the
   art prints got the distinct cardboard box.
5. **Sicherheit = `0`**, confirmed - the field asks whether this declaration
   *also* carries a separate summary safety/security dataset, which a
   standard full declaration doesn't need bolted on.

**Still genuinely open, needs a broker/Amt call, not settleable by us:**
1. Verfahren `23+00`: does partial non-return need a separate "Umwandlung in
   endgültige Ausfuhr" notification, or does the re-import declaration alone
   handle it?

Once those are settled (or accepted as working values), this file has
essentially everything needed to hand-fill a real IAA-Plus declaration for
this booth. Next step per plan: find and read the official "IHB" AES XML
schema document before considering the XML-upload automation path.
