# Zollify

One app for your business, assembled from modules loaded at runtime.

Zollify replaces ZollTool, ZollTax and ZollSource with a single multi-tenant
platform. Selling, customs, tax and sourcing are **modules** - they register
themselves against a stable host API, can be switched on and off per account,
and never import one another.

## Why it is built this way

- **A module has two halves.** Tax and Sourcing are mostly backend, so a module
  is a client face *and* a server service. One per-account list drives both.
- **Client modules load at runtime; server modules do not.** A downloaded bundle
  runs in the browser, sandboxed by CSP and verified by hash. It never runs in
  the Node process holding the database and every tenant's API keys.
- **Install online, boot offline.** The network is on the install path only. A
  business with no signal boots every module it already has, out of IndexedDB.
- **Zollify never touches the sale.** myPOS, SumUp and Nexi SmartPOS terminals take the card and
  settle to the vendor's own bank. That keeps PCI scope and money-transmission
  licensing out of the platform - see [SECURITY.md](./SECURITY.md).

## Layout

```
packages/
  sdk/            @zollify/sdk          THE boundary - all a module may import
  shared/         @zollify/shared       sync protocol, types, merge  (ported)
  platform/       @zollify/platform     shell, ModuleLoader, cache, session
  server-core/    @zollify/server-core  gateway, auth, entitlements  (ported)
  ui/             @zollify/ui           design tokens + components
modules/
  pos/            cart, checkout, receipts + nested payment provider plugins
  customs-ch/     Swiss EDEC XML, Forms 1174/1187, proforma, goods lists  (ported)
  customs-de/     German customs paperwork
  customs-hub/    one Customs entry point over the country modules
  sourcing/       suppliers and reorder drafts (client + server half)
  shopify-sync/   catalogue matching against a storefront (client + server half)
  odoo-sync/      stock level with an Odoo warehouse, till sales invoiced there (client + server half)
  price-cards/    printable price tags from the catalogue
  label-printer/  Bluetooth label printer for price tags and staff badges
  costs/          per-item cost from shipment batches, margins in the catalogue
  convention-checklist/  packing checklist per convention
  public-events/  public "where to find us" page, shop widget, iCal feed, Instagram bio
  tax/            payment clustering, myPOS verify, Lexware booking, per-event ledger (client + server half)
  consignment/    artists' work sold in your stores, commission and payouts (client + server half)
  consignment-artist/  the artist's own view of the stores that carry their work
  commissions/    custom work for a customer: deposit at the till, QR tracking page (client + server half)
  peppol-be/      Belgian Peppol e-invoices and credit notes (client + server half)
  migration/      single-use ZollTool backup importer (.json, or .zip with photos)
apps/
  web/            the shell (first target)
  server/         deployable gateway; mounts server module halves
```

`modules/` build to standalone ESM bundles; server halves compile into
`apps/server`.

Publish the bundles into the server's store with:

```bash
npm run publish:modules
```

The gateway reads its module store at boot, so after publishing, hit **Rescan
store** in Modules (or `POST /api/modules/reload` as an owner) rather than
restarting the server and dropping every open connection.

## Getting started

```bash
npm install
```

Configure the server:

```bash
cp apps/server/.env.example apps/server/.env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# paste into ZOLLIFY_JWT_SECRET, and set ZOLLIFY_REQUIRE_HTTPS=0 for local HTTP
```

Run both halves:

```bash
npm run dev:server
```

```bash
npm run dev
```

The web app proxies `/api` to the gateway, so cookies and CORS behave the same
locally as in a deployment.

## Checks

```bash
npm run typecheck --workspaces
```

```bash
npm run test --workspaces
```

The customs suite includes **golden-file tests that diff the ported engine's
output against the original legacy implementation** in
`modules/customs-ch/legacy/app.js`. If those fail, the port has drifted - that is
the point of them, so fix the code rather than the fixture.

## The module contract

A module default-exports `defineModule(...)` and touches nothing but the SDK:

```ts
import { defineModule } from '@zollify/sdk';

export default defineModule({
  id: 'customs',
  version: '0.1.0',
  sdk: '^0.1.0',          // host range; the loader refuses a mismatch
  title: 'Customs',
  requires: ['catalog'],
  minRole: 'admin',
  setup(sdk) {
    sdk.routes.add({ path: '', name: 'index', component: () => import('./views/Index.vue') });
    sdk.nav.add({ routeName: 'index', label: 'Customs', order: 120 });
    sdk.settings.panel({ id: 'declarant', label: 'Declarant', component: () => import('./views/Settings.vue') });
    sdk.on?.('sale', () => {});
  },
});
```

**The one rule to hold:** a module imports `@zollify/sdk` and nothing else from
the platform - no reaching into `@zollify/platform`, no importing another
module. Modules meet at the SDK's extension points instead. POS emits `sale`;
Tax subscribes to it; neither package depends on the other, which is why either
can be disabled, updated or removed on its own.

That rule costs nothing today and is what makes a published SDK possible later
instead of a rewrite. It is enforced in review, so it belongs in every PR.

## Status

**Built and passing (840 tests):**

*Platform*
- `@zollify/sdk` - the boundary, with a host-compatibility checker.
- `@zollify/platform` - module loader (bundled + remote resolvers), hash-verified
  immutable bundle cache, per-module storage, session handling.
- **Core** - catalogue with variants and photos, sales events, one inventory
  with per-event claims, recorded sales, discount rules, backup/restore, CSV
  export.
- **Offline-first sync** - push-then-pull, last-write-wins, epoch recovery, and
  per-op isolation so one bad payload cannot strand a device.
- `@zollify/server-core` - gateway, multi-tenant auth, entitlements, module
  registry, httpOnly refresh cookies.

*Selling*
- Cart with variants, automatic discount rules and a manual override.
- Receipts, printed to a thermal printer or through the browser.
- History with per-currency totals, reverts and CSV export.
- Cash up: expected vs counted, with a signed difference.
- One inventory the whole business draws on; an event can claim stock, and a claim
  is reserved for it. Selling past a claim draws the overage from the unclaimed
  pool. Availability is derived from sales, never decremented, so reverting a
  sale returns the stock with no compensating write.
- Charging in a local currency while the books stay in the base one.

*Modules* - POS, Customs (Switzerland, Germany and the hub over them), Sourcing,
Shopify sync, Price Cards, Label Printer, Costs, Convention Checklist, Migration,
Public events, Tax & books, Consignment (and the artist's own view), Commissions,
E-invoices for Belgium (Peppol).

*Stores and consignment* - a venue is either a dated **event** or a **store**: a
brick-and-mortar shop with no end date (`SalesEvent.kind = 'store'`). Stores sell
through the same till, stock claims, history and cash-up, so one account can run
several shops and still take a booth to a convention. The Consignment module adds
**artists** whose work the account sells: each is carried by one store or shared
between several, with a commission that can differ per store. A product tagged
with `consignorId` is the artist's, and each sale line snapshots it, so the
statement (sales per store, commission, artist's share, payouts, balance) is
replayed from the op-log and never moves when a product is reassigned later. An
artist links their **own** Zollify account - the one they run their events from -
with a single-use code from the store owner; linked, they see their items, sales
and payouts at that owner's stores under *Where I consign*, and the owner can
import items from their catalogue. That link is the only path between two
accounts' data, and the server picks every field that crosses it.

The consignment **planner** rents space by the month: each store lists the
spaces it rents out (a small shelf, a large one, a window spot - with a fee and
how many there are), an artist rents one for some months, and an upgrade stops
that rental and starts a larger one from a date (by default the next billing
period, so no month is charged twice). Started months come off the artist's
balance unless the rent is paid separately. The store also schedules **setup
moments**: the artist gets an in-app notification on their linked account and
an email with a calendar file, confirms or declines from *Where I consign*, and
the store hears back the same way.

**Commissions** track custom work from request to pickup (Requested, Accepted,
In progress, Ready for pickup, Collected, Cancelled). The record and the
customer's contact details stay on the server, never in the synced op-log. A
"Commission" button over the till takes a deposit or the final balance as an
ordinary free-price sale line whose `ref` names the commission, so payment
providers, receipts, VAT and cash-up work as for any sale; the paid-so-far is
derived from those sale lines (a reverted sale gives the balance back). The
customer follows progress at `/p/commissions/<token>`, reached by a QR code:
the token is 192 random bits per commission and an admin can replace it, the
page is plain server-rendered HTML with no script, rate limited and noindex,
and shows only the title, status, customer-visible updates, due date, amounts
and the pickup address - no contact details and no internal notes. Times are
shown in the time zone set in the module's settings, and an open page reloads
itself every five minutes until the commission is collected or cancelled. At
the till, a commission already in the sale can have its amount replaced.
A customer is one record per account (name, email, phone) that commissions point
at, so a returning customer is picked from a search instead of retyped, a
Customers tab shows everything one customer ordered, paid and still owes, and a
new customer who matches an existing email or phone is offered back, never
merged. Details are kept only while needed: once every commission of a customer
is collected or cancelled they are erased after a period an admin sets (default
30 days, 0 to 365), by a sweep at startup and every few hours that only acts
while the module is on. Erasing deletes the name, email and phone and clears the
notes, details and customer messages, and keeps title, price, payments, dates and
status. Admins can also erase one customer or all closed ones at once.

**Store events** plan what happens in the shops besides selling. *Artist of the
month* features an artist at one or more stores for a date range, optionally
with a discount: it is an ordinary core discount rule, limited to the artist's
items (`consignorIds`), the dates (`validFrom`/`validUntil`) and the stores
(`eventIds`), so every till applies it by itself, offline too. *Workshops* take
sign-ups on a public page, `/p/consignment/s/<token>` (the owner can replace
the token to retire a link): capacity, a waitlist that moves up in order when
someone cancels, a confirmation email with a calendar file and a personal
cancel link, and a notification to the store. People pay at the store; the
sign-up list marks who has. Signing up costs a proof-of-work and is rate
limited, like the online receipt.

**Sharing and stock.** A linked artist chooses which items of their own
catalogue a store sells; the server writes them into the store's catalogue
(photos included, following the artist's edits) under the same id, so the
artist's own labels scan at the store's till. A label of an item the artist
has not shared yet shares it and tells them. Where the artist and store use
different currencies, the store sets a rate, rounding and per-item prices,
like an event abroad. Artists restock in person (add or recount from *Where I
consign*), or send a package that only reaches the shelf once the store
confirms what arrived. The till groups a store's items by artist, then by
type, and labels can carry the artist's name. Staff accounts (role *member*)
ring up sales and cash up as themselves, but cannot see or change artists,
commissions, payouts or reports. Sales totals are the owner's too unless an admin
switches on *Staff can see sales totals* (Settings → Team): until then staff
see their own sales one by one, no takings, stats or exports, and cash up
blind - they count the box, the owner compares.

*Shared tills* - several people of one account can use one device at once.
The device stays signed in as whoever set it up; under Settings → This device
→ Shared till it locks with a PIN. Each colleague is added once from the lock
screen with their own email and password (and 2FA code), and from then on taps
their name and enters their personal PIN. The server checks the PIN, counts
wrong guesses (a few minutes' lockout after 5, removed from the device after
10) and hands the device a short-lived token for that person, so their role
applies - staff stay staff on the owner's device - and their sales are
credited to them, even when they sync after someone else took over. The till
locks from its header or the sidebar, after a set idle time, or after each
sale. Offline, someone who unlocked online once can still unlock, if they do
not outrank the device's own user: they then act with the device's access, so
a PIN check kept on the device never opens more than the device already could. **Staff
badges** stand in for the name and PIN: an admin prints each person a badge
with a Code 128 barcode (Settings → Team → Badge) - on a card, on a label
printer installed on the computer (62 × 29, 57 × 32, 50 × 30 or 40 × 30 mm),
as an image for a printer's own app, or through the Label Printer module's
Bluetooth printer - and scanning it - with a
handheld scanner or the camera - unlocks the lock screen as its owner, or
hands an unlocked till over when scanned into the till's search. A badge only
works on tills its owner was added to; a device can still ask for the PIN
after the badge, and a new badge retires the old card.

**Fees and reports.** A store can charge an artist a fee - a missed setup
(straight from the planner), not responding, late stock, handling, damage -
which comes off their balance; the artist is told by notification and email,
can object (the owner hears), and the owner can waive it. The **report**
closes every month or every two weeks, in the store's time zone: sales,
takings, discounts by name, VAT per rate, cash and card, what cards cost (a
rate the store sets, optionally carried by artists in proportion to their
share), commission, own stock, and per artist what the period earned against
rent and fees and what is owed at its end. Payouts are recorded from it
without ever paying the same money twice, it downloads as a spreadsheet, and
when a period closes the owner gets it by email with the spreadsheet
attached.

**Discounts.** A store's discount rules can be a plain percent off, aimed at
product types, products, variants or one or more artists' work, and limited
to some days or some events and stores. Linked artists can put their own work
in a store on discount from *Where I consign* - within the store's limit
(Consignment → Reports → Settings), on all their items there or some, for
some days or until ended. It becomes an ordinary rule in the store (every
till applies it, offline too), the store can end it under Discounts, and
both sides are told.

*Webhooks* - Settings → Webhooks posts to a Discord or Slack channel, or as
signed JSON anywhere: each sale, a daily or weekly summary (in the webhook's
time zone), and the in-app notifications by category - rentals and setups,
restocks and packages, store events and workshops, shared items, artist
discounts, fees, consignment reports. An artist's account can also hear each
sale of its work in a store, and its summaries count those sales. Server
modules post through `ctx.webhooks.emit()` and add summary lines with
`webhookReport`. Deliveries go out one at a time per webhook, never hold up
a sale, and a webhook that keeps failing switches itself off. The server only
posts to public https addresses unless `WEBHOOK_ALLOW_PRIVATE=1`.

*Nexi SmartPOS* (Nets SmartPOS N950, e.g. in Denmark) - card payments start
from any till over the cloud: the server sends the amount to the terminal
through Poynt's Payment Bridge (the platform SmartPOS runs on), the customer
pays there, and the terminal posts the outcome back to a one-off callback
URL. Each account sets it up under Settings → Payments: an owner or admin
adds their own Poynt cloud app (application id and private key from the
Poynt developer portal, kept encrypted on the server), taps Connect to
allow it on their Nexi business, and each till picks its terminal. So every
shop on one server has its own app, Nexi account and terminals. A server can
also offer one app to accounts without their own - see `POYNT_*` in
`apps/server/.env.example`. Nexi needs the server on a public https address
to report payments back. Not yet tried against a live terminal.

*Business profile* - one place says who the business is: name, address,
contact, VAT number, EORI, a Belgian enterprise number, and the webstore and
social links (Settings -> Business profile, asked once in the setup wizard).
Modules read it by default and keep a value of their own only when it
differs, as the customs declarant does: receipts, customs paperwork and the
Peppol seller all follow it, and an artist's links appear under the online
receipt (and on paper, if switched on in Receipts). Links are checked on the
server (https only, length caps, Instagram and TikTok handles made canonical).

*E-invoices for Belgium (Peppol)* - the `peppol-be` module (admins) writes
invoices and credit notes as Peppol BIS Billing 3.0 UBL, as Belgian B2B
invoices must be from 2026. Each one is checked against the Peppol and
Belgian rules before it is issued (enterprise number, VAT categories, the
small-business exemption, reverse charge, intra-EU delivery); the seller
is the business profile unless the invoice settings override a field; numbers are
taken only on issue, per series and year, without gaps, and an issued
invoice is frozen - corrections are credit notes. Invoices can start from a
till sale, customers are checked against the Peppol Directory, and sending
goes through the business's own Storecove account (its API key is stored
encrypted and never reaches the browser). With any other access point,
download the XML and upload it there. The generated XML passes the official
CEN and OpenPEPPOL schematrons and the UBL 2.1 schema.

*Problems* - Settings → Problems lists what quietly failed for owners and
admins: a webhook that keeps failing or was switched off, email that does not
go out, a sync device whose pushes crash a module, a scheduled job that threw,
Peppol, myPOS, SumUp, Lexware and Nexi calls that fail, and the host's backup
and update status. Repeats update one row, a success closes it, a new error
rings the bell once a day at most, and the owner gets one email digest a day
unless they opt out. Server modules report through
`reportProblem(ctx, accountId, { kind, key, severity, message })` and
`resolveProblem(ctx, accountId, kind, key)`; rows never hold secrets or payloads
(see docs/security.md).

Security notes and settings are in [docs/security.md](docs/security.md);
legal notes per country in [docs/germany-compliance.md](docs/germany-compliance.md)
and [docs/denmark-compliance.md](docs/denmark-compliance.md).

*Notifications and email* - platform features any server module can use
through its context: `ctx.notify(accountId, …)` puts a note under the shell's
bell (rung live over the WebSocket), and `ctx.mail.send(…)` sends email when
`SMTP_URL` and `MAIL_FROM` are set. Without them nothing is emailed and the
app says so; notifications work either way.

*Tax & books* (the ZollTax port) - **Payments**: drop a myPOS export or
statement, a Shopify orders CSV or a Wise history, or pull straight from
myPOS / Shopify / SumUp; rows cluster per convention (a day-and-a-half gap on
one terminal), online orders group per month; match clusters to events (or
auto merge & match across terminals), verify against the myPOS Banking API,
pull cash from the till, and book revenue per cluster and fees per month into
Lexware with the report PDF attached. The working set persists in the module's
own IndexedDB, and what was booked is remembered server-side. **Ledger**: per-
event P&L from op-log revenue against booth / travel / accommodation costs,
invoices attached, optional Claude invoice scanning behind daily caps.
Credentials live encrypted per account under Settings → Integrations.

*Public events* (the ZollEvents port) publishes at `/p/public-events/<slug>`:
the page, `/events.json`, `/embed.js` (drop-in widget for any site), `/events.ics`
(subscribable calendar) and `/instagram.txt` (bio text). Rendered on the gateway
from the account's op-log, so it updates whenever an event is edited. Public
module halves mount under `/p/` with no session; the module resolves the account
from the slug and refuses unless the module is enabled for it. Hall, booth number,
link and note are part of the event (`SalesEvent.booth`, edited under Events, Edit,
Booth); the module's per-event overlay only keeps publishing choices (hidden, Instagram
handle) and legacy booth values, which fill in wherever the event has none.

*Deployment* - multi-stage Dockerfile, compose, `deploy.sh` that backs up before
restarting (and `--auto` for an unattended timer), `/health`, and the gateway
serving the built shell. See *Deploying on a VPS* below.

*Android shell* - `android/`, three flavours, self-update for compat/full via
`/api/updates/*`; see `.github/workflows/android.yml`.

**Not built:**

- **Billing** - deferred. The per-account enabled-modules list is its seam.

The twenty-point security baseline is tracked in [SECURITY.md](./SECURITY.md),
with each control pointing at where it is enforced. Two items remain open, both
genuinely not-yet-needed: **file upload limits** (product images are stored
locally and never uploaded) and **response schemas**, which would make response
trimming structural rather than a per-route convention.

## Deploying on a VPS (EC2 + Caddy)

The host needs Docker, git and Caddy - nothing else. Images are built by
GitHub Actions and pushed to GHCR on every push to `master`; the host only pulls.

1. **Clone and configure.** `git clone` to `/home/ubuntu/zollify`, then
   `cp apps/server/.env.example apps/server/.env`. Nothing in it is required:
   the signing secret is minted into the data volume on first start, and the
   first account created on the fresh server becomes its owner - open the
   site once it is up and pick *Set up this server*. The repo and its
   GHCR package are public, so pulling needs no token - make sure the package
   `zollify` is set to public under the repo's Packages page once.
2. **Caddy.** Add the block from `apps/server/Caddyfile.example` to your
   Caddyfile and reload. Caddy does TLS; the gateway listens on
   `127.0.0.1:8787` only and trusts `X-Forwarded-Proto`. If Caddy itself runs
   in Docker, set `CADDY_NETWORK=<its network>` in `.env` (see
   `docker network ls`) and proxy to `zollify:8787` - the container joins
   that network on deploy.
3. **First start.** `./apps/server/deploy.sh --auto` - pulls the image, the
   Android APKs from the latest release, and starts the container. Check
   `https://<host>/health`.
4. **Deploy on push.** Add repo secrets `DEPLOY_HOST`, `DEPLOY_USER`,
   `DEPLOY_SSH_KEY` (private key; put its public half in the server user's
   `~/.ssh/authorized_keys`), `DEPLOY_PATH` (`/home/ubuntu/zollify`) and
   optionally `DEPLOY_PORT`. `.github/workflows/deploy.yml` then SSHes in after
   each image/APK build and runs `deploy.sh --auto`: `git pull`, fetch APKs,
   pull the image, restart only when it changed (a SQLite backup lands in
   `backups/` first).
5. **Update button.** `sudo cp apps/server/systemd/zollify-deploy.* /etc/systemd/system/`
   then `sudo systemctl enable --now zollify-deploy.path`. Settings → Server
   admin → *Update server* drops `apps/server/deploy/requested`; the path
   unit runs the same `deploy.sh --auto`. `journalctl -u zollify-deploy`
   shows what it did.

Rollback: `ZOLLIFY_IMAGE_TAG=<older sha> ./apps/server/deploy.sh --auto`;
every image is also tagged with its commit, and Server admin shows the one
running.

## A note on verification

`declare module '*.vue'` means a missing component still typechecks. The build
is the gate for component wiring, not `tsc` - `npm run build -w @zollify/web`
is part of CI for that reason.
