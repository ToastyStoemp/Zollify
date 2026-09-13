# Boothly

One app for the booth, assembled from modules loaded at runtime.

Boothly replaces ZollTool, ZollTax and ZollSource with a single multi-tenant
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
- **Boothly never touches the sale.** myPOS and SumUp terminals take the card and
  settle to the vendor's own bank. That keeps PCI scope and money-transmission
  licensing out of the platform — see [SECURITY.md](./SECURITY.md).

## Layout

```
packages/
  sdk/            @boothly/sdk          THE boundary — all a module may import
  shared/         @boothly/shared       sync protocol, types, merge  (ported)
  platform/       @boothly/platform     shell, ModuleLoader, cache, session
  server-core/    @boothly/server-core  gateway, auth, entitlements  (ported)
  ui/             @boothly/ui           design tokens + components
modules/
  pos/            cart, checkout, receipts + nested payment provider plugins
  customs/        EDEC XML, Forms 1174/1187, proforma, goods lists  (ported)
apps/
  web/            the shell (first target)
  server/         deployable gateway; mounts server module halves
```

`modules/` build to standalone ESM bundles; server halves compile into
`apps/server`.

## Getting started

```bash
npm install
```

Configure the server:

```bash
cp apps/server/.env.example apps/server/.env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# paste into BOOTHLY_JWT_SECRET, and set BOOTHLY_REQUIRE_HTTPS=0 for local HTTP
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
import { defineModule } from '@boothly/sdk';

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

**The one rule to hold:** a module imports `@boothly/sdk` and nothing else from
the platform — no reaching into `@boothly/platform`, no importing another
module. Modules meet at the SDK's extension points instead. POS emits `sale`;
Tax subscribes to it; neither package depends on the other, which is why either
can be disabled, updated or removed on its own.

That rule costs nothing today and is what makes a published SDK possible later
instead of a rewrite. It is enforced in review, so it belongs in every PR.

## Status

Built and passing: SDK, platform (loader, cache, session, per-module storage),
server gateway with ported multi-tenant auth, entitlements, module registry, POS
and Customs modules, and the web shell.

Not built yet: sync engine wiring, catalog/events core modules, Sourcing, Price
Cards, Shopify sync, the Android shell, and billing. See the architecture
document for sequencing, and [SECURITY.md](./SECURITY.md) for the security
baseline and its open items.
