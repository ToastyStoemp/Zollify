# Print Desk

A small desktop app (Electron) that links a file on this computer to each Zollify
product or variant, prints any number of them through PhotoCraft with the print
settings stored per item, and counts the printed copies into the Zollify inventory.

It replaces the ZollTool Photoshop plugin for the print run. The files and print
settings never leave this computer; only the stock count goes to Zollify.

## Needs

- [PhotoCraft](https://getartcraft.com/apps/photocraft) installed - the app runs
  its `photocraft-cli` for every print (`file.print`), so printers, paper and
  colour handling are PhotoCraft's. The usual install folder is found on its
  own; otherwise point the app at `photocraft-cli` with **Browse**. A local
  development build works the same way: Browse to its `photocraft-cli.exe`.
- A Zollify account on a server you can reach. Sign in as an owner or admin:
  staff cannot change the inventory.

## Run

On Windows, double-click **Print Desk.cmd** in this folder (or a shortcut to
it on the desktop). It installs the dependencies on first run, then builds and
starts the app; its console window stays open while the app runs.

From a terminal at the repo root:

```bash
npm run start -w @zollify/print-desk
```

Both build the renderer (Vite) and the main process (tsc) and start Electron.

## How it works

- Sign-in is the shell's: `/api/auth/login` as a native client, or by QR
  (`/api/auth/link/start` + `poll`, approved from a signed-in phone under
  Settings → Account & security → Sign in another device). The refresh token
  is kept in the OS keychain through Electron's `safeStorage`.
- The catalogue is the account's op log (`/api/sync/pull`), reduced to one row
  per product or variant with its counted stock (`inventory.set`).
- A file is linked with **Link a file**, or by dragging it from File Explorer
  onto the row (PSD, PSB, PCRAFT, PNG, JPG, TIFF, WebP). Linking reads the
  image size (`photocraft-cli info`) and sets portrait or landscape to match.
  The driver settings (`printerSettings`) are kept: a PhotoCraft with the
  Orientation change (storytold/photocraft#7847) turns them to the layout when
  it prints. PhotoCraft 0.10.0 refuses a landscape layout on portrait driver
  settings, so with it, set landscape in PhotoCraft's Print Settings… first.
- Each row's file and `file.print` params live in `print-desk.json` in the app's
  user-data folder, keyed by account and `productId:variantId`. The JSON box in
  a row's settings takes any further PhotoCraft print param as it is, including
  `printerSettings` (the Windows driver settings PhotoCraft's Print Settings
  dialog gives you) and `printerProfile`.
- **Load from PhotoCraft**, in a row's settings, fills the form with the settings
  of your last print in PhotoCraft (File › Print), driver settings and printer
  profile included, read from PhotoCraft's preferences.json the way PhotoCraft
  finds it. Save it, or apply it to all items of that size: set a print up once
  in PhotoCraft per size, no copy and paste.
- Under the JSON box, the **colour and driver settings** are read out by name:
  the ICC profile and intent PhotoCraft converts with (when PhotoCraft manages
  colour), then paper, orientation, borderless, media type, paper source,
  quality, the driver's colour correction and Windows colour management. The
  printer's own names come from its driver (Windows only): its catalog for the
  codes, and its PrintTicket for what it keeps in its private data, such as
  borderless. A driver without a PrintTicket shows the public fields only.
- **Detect sizes** sets each item's paper from an A0-A6 size in its variant
  name, else its product name ("A3", "Poster a4"; not "A3+"). A3-A5 go to
  PhotoCraft by name, the other A sizes as points.
- **Global print settings** (toolbar): one set of settings for every item
  that has no settings of its own. Each item still prints on its own paper
  (the A size in its name, else its own paper) and in its own orientation (set
  from its image when the file is linked). "Load from PhotoCraft" fills them
  from your last PhotoCraft print. A row using them can change its own paper,
  orientation and scaling (scale to fit, or an exact size) and keep the rest
  global; "All settings of its own" gives it a full copy to change, and back.
- Without **scale to fit**, the size shows as width and height in cm, mm or
  inches next to the scale (from the linked image's pixels and resolution, as
  PhotoCraft prints it); typing either sets the scale. Positions use the same
  unit, which is kept between sessions.
- **Driver settings follow the paper.** PhotoCraft refuses driver settings
  whose paper differs from the layout, so when an item prints on another size
  than its driver settings were made for, Print Desk sets the driver's paper of
  that size (from the printer's catalog) and lets the driver check the
  settings (DocumentProperties, no dialog). Media, quality, borderless and tray
  stay as they were. A printer without a paper of that size fails that item.
- A row's settings can be applied to **all items of its size** or to **all
  items** (without global settings): items of another size keep their own
  paper, and the driver settings go along. Linked files are never touched.
- **Target stock** is the stock to print up to, kept between sessions. Each
  product or variant has its own in the Target column. An empty box uses the
  target of its A size (**Per size** in the toolbar), else the **Main target**;
  the grey number shows which. **Fill to target** sets each item's print count
  to what it takes to reach its target from its Zollify on-hand count (0 when
  already there).
- **Fill from last event** sets every item's print count to the copies the
  last closed event sold of it (the closed event that ended last, stores not
  counted), less reverted sales. Items it sold none of go to 0. Items without a
  linked file are named, as they cannot print.
- **Paper stock** (toolbar) takes the paper of each printed copy off a material
  in Zollify (Sourcing → Materials): pick the material for each paper size the
  catalogue prints on. It goes through your Zollify sign-in
  (`/api/m/sourcing/printing/…`) when that may: an owner or admin, with
  Sourcing on. Otherwise (a staff account, or a server without those routes)
  paste a printer key made under Materials → Printing app; it is kept
  encrypted like the sign-in token and checked with Zollify before it is
  saved. Copies are logged as they come out, like the stock: a
  cancelled job takes only what printed, and each use carries an id made from
  the run, the item and the copies, so a report sent twice is logged once.
  The paper is the size the item prints on (its settings, or the global ones
  with the size from its name); a custom size takes nothing.
- **Paper needed**: under the toolbar, the sheets each paper size needs for the
  queued copies, with what Paper stock says is on hand; a size short of paper
  shows red. Click a size to print only that size ("Print A3 only"); "All
  sizes" goes back. **Fit to paper stock** cuts the copies of each size that is
  short to the sheets on hand, each item keeping its share of what it wanted
  (30 and 25 wanted, 48 sheets: 26 and 22).
- **Smart fit to stock** gives the sheets of a short size to the copies most
  likely to sell instead: each item's sales per event day at events over the
  last year (stores left out), times the days of the next event (scaled by how
  its earlier editions in the same series sold), make its forecast; a copy is
  worth its price times the chance it sells after what is on hand (Poisson
  demand). Never more copies than an item asked for. An item with no sales in
  the last year takes its own count as its forecast.
- The toolbar keeps the search, the size filter and Print; the rest is in two
  menus. **Fill**: from last event, to target, and Targets… (the main target
  and one per size). **Setup**: global print settings, paper stock, detect
  sizes, and adding printed copies to the Zollify stock. The two fits are one
  **Fit to paper stock** menu in the Paper needed bar. Messages show as toasts
  in a corner, so they never move the page; a notice goes after 12 s (not
  while the pointer is on it), an error stays until dismissed.
- **Paper size quick filter** (next to the search): shows only one size's
  items and prints only that size, the same choice as the Paper needed chips.
- **Hide** (per row) is for items printed elsewhere, such as outsourced ones:
  they leave the table, the fills and the print run. "Show hidden" lists them
  again, dimmed, with **Unhide**. Kept per account between sessions.
- **Stock stays current.** The catalogue and stock are read from Zollify again
  every 30 s and whenever the window comes to the front, and before **Fill to
  target**; only ops new since the last read come over. The header shows when
  it last synced. Printed copies are added onto Zollify's count as it is at
  that moment, so a stock count made in the Zollify app meanwhile is kept.
- **Print all** runs one `file.print` per queued row with `copies` set. With
  "Add printed copies to Zollify stock" on, copies are added as they come out,
  not when they are sent: an `inventory.set` op (the same op a stock count in
  the web app makes) each time the queue reports more copies done. When a job
  leaves the queue, Windows' print log (PrintService/Operational) says how it
  ended: event 307 with the pages printed, or 310 alone for a job cancelled in
  the queue, which then counts only the copies the driver had sent. Without a
  log entry within 15 s, all copies count. A print cancelled on the printer
  itself after Windows sent it can't be seen.
- On Windows, each job is then followed in the print queue (`Win32_PrintJob`,
  every 2 s) until it leaves it. PhotoCraft prints every copy as one page of
  the job, so pages printed is copies done; the row shows a bar, the driver's
  status and printer problems (no paper, offline...), and the toolbar the
  copies left in the whole run. "Printed" is what the driver has sent to the
  printer. Elsewhere a job shows as sent, without progress.

## Price cards

**Price cards** (next to **Prints**, above the toolbar) makes the price cards for
the table: one master card drawn by PhotoCraft, a theme per card, prices from the
catalogue. It replaces the ZollPriceCards Photoshop plugin.

- **A card prices** whole product types (every keychain on one card) or single
  products and variants (normal and flower stickers on cards of their own). Its
  rows follow from those items: one price is a big price; several prices are a
  line each, named after a size the products share ("A4") or else the product;
  a tiered discount adds "2 FOR 20.-" deals; a combo adds a "Bundle" line at
  its members' prices less the discount; buy-x-get-y and every-nth discounts add
  a line of small print. A discount on only some of the card's items says which
  ("3 × A4  65.-", "Mousepad: buy 2, get 1 free"). Discounts count while they
  are valid today. A whole type leaves out unlisted products (off the price
  lists); a product picked by name counts even when unlisted. Products not for
  sale stay off.
- **Without a card** (toolbar) lists the listed products for sale that no card
  prices yet, with their price. Pick a theme for each, or one for all, and
  **Add** (or **Add all**): each gets a card of its own, named after it, drawn
  straight away and ticked for the sheet, to change afterwards under Edit.
- **Small print** is the products' price notes, or lines of the card's own
  ("Hahnemühle paper", "4 random stickers"). Any line's name can be changed and
  any row left off, in the card's Edit panel.
- **Themes** are the colours (background, frame, title band, title, text, deal
  prices, sparkles), a font (Bahnschrift by default) and an optional mascot PNG on
  the title band's right end. A card takes its theme's mascot, none, or a PNG of
  its own. The sparkles are drawn as four-pointed stars.
- **Style and size**: a card (title band, rows under each other) or a strip like
  a shelf tag (a heading such as "Available in:", then the sizes side by side,
  each over its price; deals and small print under them). A strip's heading can
  be switched off: its title then only names it in the list. Either comes half an
  A4 wide (10.5 cm, two across) or a third (7 cm, three across), which is the
  same master drawn at two thirds. Each width gets sheets of its own.
- **Draw** makes the card a PSD in the cards folder (Documents\Price cards unless
  changed), 1240 px wide (half an A4 at 300 ppi), as tall as its rows. Every part
  is a real layer: shapes for the background, frame and band, text layers named
  after their rows, the mascot as an embedded Smart Object. **Open** opens it in
  PhotoCraft to change by hand.
- **Prices stay current without losing hand edits.** A card shows "New prices"
  when a price or name it prints changed: **Update prices** (or **Update all**)
  writes only the texts that changed into the PSD, by layer name
  (`photocraft-cli run --cmd type.edit`), so whatever was changed by hand stays.
  When the rows themselves change (a deal added, a new size), the card says
  "Rows changed: redraw": **Redraw** starts the PSD again from the master.
- **Centre the number** (card editor, for a card with a big price): the price sits
  in the middle by its number, what the price format adds (".-") hanging to the
  side, as "15" centred with ".-" to its right. Switching it asks for a redraw.
- **Prices** (toolbar): the catalogue's, or an event's that charges in a currency
  of its own (Narcon · SEK, Herofest · CHF). With an event, every price on the
  cards is what its till charges: converted at its rate and rounded to its step,
  or the price pinned for it under Local prices; deal and bundle totals the same
  way. Swapping marks the cards "New prices" and **Update all** writes them into
  the PSDs; a card whose lines split (some variants pinned, some not) asks for a
  redraw. Back to Catalogue, they are up to date again.
- **Price as** sets how a price reads: `{n}.-` gives `15.-`, `€{n}` gives `€15`.
  With catalogue prices, a rate and a rounding step convert them by hand.
- **Make A4 sheets** lays the ticked cards out on A4 pages (2480 x 3508 px at
  300 ppi), each card an embedded Smart Object, so a sheet can still be changed
  in PhotoCraft. **Fewest sheets** (on unless switched off): the tallest cards
  first, each into the first gap on any sheet, cards of one theme stacked
  together so a cut a little off shows no other colour, and half cards and
  third strips sharing a sheet when it has the width. Off: the list's order
  (↑ ↓), each width on pages of its own. **Cut marks** adds thin grey crosses at
  every card corner, on a layer of their own ("Cut marks") that can be hidden.
  Each page can be opened, saved as a PDF beside it, or printed on A4.
- **Print settings** (toolbar): the printer, paper, colour profile and driver
  settings the sheets print with, apart from the art prints; "Load from
  PhotoCraft" takes your last print in PhotoCraft. Until they are saved, sheets
  print with the global print settings' printer and driver settings, on A4.
