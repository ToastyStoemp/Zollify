# Zollify

One app for the booth, assembled from modules loaded at runtime.

Zollify replaces ZollTool, ZollTax and ZollSource with a single multi-tenant
platform. Selling, customs, tax and sourcing are **modules** — they register
themselves against a stable host API, can be switched on and off per account,
and never import one another.

## Why it is built this way

- **A module has two halves.** Tax and Sourcing are mostly backend, so a module
  is a client face *and* a server service. One per-account list drives both.
- **Client modules load at runtime; server modules do not.** A downloaded bundle
  runs in the browser, sandboxed by CSP and verified by hash. It never runs in
  the Node process holding the database and every tenant's API keys.
- **Install online, boot offline.** The network is on the install path only. A
  booth with no signal boots every module it already has, out of IndexedDB.
- **Zollify never touches the sale.** myPOS and SumUp terminals take the card and
  settle to the vendor's own bank. That keeps PCI scope and money-transmission
  licensing out of the platform — see [SECURITY.md](./SECURITY.md).

## Layout

```
packages/
  sdk/            @zollify/sdk          THE boundary — all a module may import
  shared/         @zollify/shared       sync protocol, types, merge  (ported)
  platform/       @zollify/platform     shell, ModuleLoader, cache, session
  server-core/    @zollify/server-core  gateway, auth, entitlements  (ported)
  ui/             @zollify/ui           design tokens + components
modules/
  pos/            cart, checkout, receipts + nested payment provider plugins
  customs/        EDEC XML, Forms 1174/1187, proforma, goods lists  (ported)
  sourcing/       suppliers and reorder drafts (client + server half)
  shopify-sync/   catalogue matching against a storefront (client + server half)
  price-cards/    printable price tags from the catalogue
  public-events/  public "where to find us" page, shop widget, iCal feed, Instagram bio
  tax/            payment clustering, myPOS verify, Lexware booking, per-event ledger (client + server half)
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
`modules/customs/legacy/app.js`. If those fail, the port has drifted — that is
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
the platform — no reaching into `@zollify/platform`, no importing another
module. Modules meet at the SDK's extension points instead. POS emits `sale`;
Tax subscribes to it; neither package depends on the other, which is why either
can be disabled, updated or removed on its own.

That rule costs nothing today and is what makes a published SDK possible later
instead of a rewrite. It is enforced in review, so it belongs in every PR.

## Status

**Built and passing (156 tests):**

*Platform*
- `@zollify/sdk` — the boundary, with a host-compatibility checker.
- `@zollify/platform` — module loader (bundled + remote resolvers), hash-verified
  immutable bundle cache, per-module storage, session handling.
- **Core** — catalogue with variants and photos, sales events, one inventory
  with per-event claims, recorded sales, discount rules, backup/restore, CSV
  export.
- **Offline-first sync** — push-then-pull, last-write-wins, epoch recovery, and
  per-op isolation so one bad payload cannot strand a device.
- `@zollify/server-core` — gateway, multi-tenant auth, entitlements, module
  registry, httpOnly refresh cookies.

*Selling*
- Cart with variants, automatic discount rules and a manual override.
- Receipts, printed to a thermal printer or through the browser.
- History with per-currency totals, reverts and CSV export.
- Cash up: expected vs counted, with a signed difference.
- One inventory the whole booth draws on; an event can claim stock, and a claim
  is reserved for it. Selling past a claim draws the overage from the unclaimed
  pool. Availability is derived from sales, never decremented, so reverting a
  sale returns the stock with no compensating write.
- Charging in a local currency while the books stay in the base one.

*Modules* — POS, Customs, Sourcing, Shopify sync, Price Cards, Migration, Public
events, Tax & books.

*Tax & books* (the ZollTax port) — **Payments**: drop a myPOS export or
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
from the slug and refuses unless the module is enabled for it.

*Deployment* — multi-stage Dockerfile, compose, `deploy.sh` that backs up before
restarting, `/health`, and the gateway serving the built shell.

**Not built:**

- **Android shell** — deferred. Costs the four terminal providers that need
  native plugins (myPOS GO2/Carbon/Glass, SumUp) until it lands; manual, bridge
  and Carbon-remote work on the web today.
- **Billing** — deferred. The per-account enabled-modules list is its seam.
- Smaller carry-overs from ZollTool: customer display mode, QR scanning, price
  comparison, PIN lock, cost tracking and PDF reports.

The twenty-point security baseline is tracked in [SECURITY.md](./SECURITY.md),
with each control pointing at where it is enforced. Two items remain open, both
genuinely not-yet-needed: **file upload limits** (product images are stored
locally and never uploaded) and **response schemas**, which would make response
trimming structural rather than a per-route convention.

## A note on verification

`declare module '*.vue'` means a missing component still typechecks. The build
is the gate for component wiring, not `tsc` — `npm run build -w @zollify/web`
is part of CI for that reason.
