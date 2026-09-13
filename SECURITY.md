# Security baseline

Status of the twenty-point checklist against what is actually in the repository.
Each item says **where** it is enforced, so a claim can be checked rather than
taken on trust. Items that are only partly done say so — an overstated control
is worse than a missing one, because nobody goes back to finish it.

Legend: **Done** · **Partial** — works but has a named gap · **Open** — not built yet.

---

## 1. Hide API keys — Done (by architecture)

No integration key ever reaches a browser. Tenant credentials (Lexware, Shopify,
myPOS, SumUp, Anthropic) live server-side and are used only by server module
halves, which is one of the reasons server modules are **deployed with the
gateway rather than loaded at runtime**: downloaded code must never run in the
process that holds them.

`apps/server/.env.example` documents every variable; `.env` is gitignored.

## 2. Purge Git secrets — Done (for this repo)

Zollify starts as a fresh repository with no imported history, so there is no
secret-bearing past to purge. `.gitignore` excludes `.env*` (except the example),
`*.pem`, `*.key`, `secrets.json`, and the server's `data/` directory.

> **Carry-over task:** the old Zoll* repositories are *not* covered by this. Scan
> those before archiving, and rotate anything found. Zollify re-enters all keys
> fresh, so rotation costs nothing here.

## 3. Use public DB key — Done (not applicable in this shape)

There is no browser-accessible database. The client holds no database
credentials at all; it reaches SQLite only through authenticated gateway routes.
The equivalent risk — a privileged key shipped to the client — cannot occur.

## 4. Row-level security — Done

`accountId` is the row-level boundary and is taken from the **verified token**,
never from a request body or query:

- `packages/server-core/src/app.ts` → `identityOf()` derives `{ userId, accountId, role, allowedEventIds }` from JWT claims.
- Every module route receives that identity via `ModuleContext.identity(req)`.
- Queries filter on it — see `apps/server/src/modules/tax.ts`, where both routes scope by `accountId`.

Helper scoping (`allowedEventIds`) rides along in the same object.

## 5. Encrypt sensitive data — Done

`packages/server-core/src/secretbox.ts` (AES-256-GCM, key derived from the JWT
secret) encrypts secrets at rest. Password hashes are argon2id, not encryption,
which is correct.

`makeSecretBox` now takes a salt, so each domain derives a **different key from
the same secret** — the TOTP key and a module's credential key are not the same
key. The default salt is the original one, since changing it would make existing
TOTP blobs undecryptable.

The first module to hold a real credential uses it: Shopify's Admin API token is
stored as an encrypted blob under the `zollify-module-credentials-v1` salt, is
never returned to the client, and never leaves the server process.

> **Standing rule:** anything credential-shaped a server module stores goes
> through `secretbox`. Plain config (a shop domain, an API version) does not.

## 6. Enforce server-side auth — Done

Authentication is a gateway-level hook, not a per-route decision:

```
app.register(async (api) => {
  api.addHook('onRequest', app.authenticate);   // every /api route
  registerModuleRoutes(...);
  mountServerModules(...);
}, { prefix: '/api' });
```

The client's route guards (`apps/web/src/router.ts`) exist for UX. They are not
a control, and the code says so.

## 7. Lock record access — Done

`packages/server-core/src/modules/mount.ts` gates every module route **once,
centrally**, before any module code runs:

1. Authenticated (inherited from the gateway hook).
2. The account has the module enabled → otherwise `402 module_not_enabled`.
3. The caller meets the module's `minRole` → otherwise `403`.

A module physically cannot forget these, which is the only way the property
survives new modules being added.

## 8. Block field tampering — Done

- Input is parsed with zod schemas (`routes/modules.ts`, `modules/tax.ts`); unknown fields are dropped rather than trusted.
- Identity fields (`accountId`, `role`, `userId`) are never read from client input.
- The module-toggle route additionally requires `admin`, so a helper cannot enable a module for themselves.
- Client-declared module ids are validated against the server's published store — a request cannot invent one.

## 9. Secure session cookies — Done

The access token is held in memory only and never written to `localStorage`.
The refresh token never reaches JavaScript: `refresh-cookie.ts` moves it out of
the response body into an **httpOnly, Secure, SameSite=Strict** cookie scoped to
`/api/auth`, and injects it back on the way in so the ported route still sees
the field it expects.

Adapting the transport rather than rewriting `auth.ts` keeps single-use
rotation, per-flavor TTLs and device carry-forward exactly as they were proven
in ZollTool. The hooks are registered on the instance, not per route, so a new
auth route cannot forget to participate.

On the client, `credentials: 'same-origin'` is forced on every request so the
cookie can never be attached cross-origin, and concurrent refreshes are
coalesced — otherwise a page load firing six requests would rotate the token six
times and invalidate its own session.

This matters more here than in a typical app: runtime-loaded modules execute in
this origin. An XSS bug can at worst borrow a 15-minute access token; it cannot
read an httpOnly cookie at all.

**Covered by tests** that drive the real gateway: no `refreshToken` in any auth
response body, correct cookie attributes, refresh working from the cookie alone,
rotation on every refresh, replay of a rotated token refused, and the `Secure`
flag following the HTTPS setting.

> A native shell opts out with `x-zollify-client: native` and keeps the token in
> platform secure storage, which is a better fit than a cookie in a WebView.

## 10. Hash passwords — Done

argon2id via the `argon2` package, ported unchanged. Login verifies against a
constant dummy hash when the email is unknown, so a missing user costs the same
time as a wrong password and the timing side-channel that would reveal which
emails exist stays closed.

## 11. Rate limit login — Done

`@fastify/rate-limit` is registered globally (300/min) with `keyGenerator` set to
the real client IP — behind a proxy, the default would put every request in one
bucket and the limiter would protect nothing. `trustProxy` is configurable so the
forwarded address is only believed when a proxy is genuinely in front.

> Auth routes should carry a tighter bucket than the global one; the ported
> `auth.ts` has its own attempt handling, which should be reviewed against the
> new limiter rather than assumed to compose.

## 12. Bot protection — Done

`packages/server-core/src/captcha.ts` is ported and issues/verifies challenges on
the auth paths.

## 13. Parameterise queries — Done

Every query uses `better-sqlite3` prepared statements with bound parameters.
There is no string-concatenated SQL anywhere in the repository, including the
new entitlements and Tax code.

## 14. Validate all input — Done (new code) / ongoing

zod schemas guard new route boundaries. `bodyLimit` is 2 MB. Module ids are
constrained by pattern (`/^[a-z][a-z0-9-]*$/`) both in `defineModule` and at the
toggle route.

> Ported routes (`sync`, `devices`, `admin`) carry ZollTool's own validation;
> they should be re-reviewed as each is brought into use.

## 15. Escape user content — Done

- Vue escapes interpolated text; there is no `v-html` anywhere in the repository.
- Toast messages come from modules and are bound as text, never markup.
- Generated customs documents are rendered in a **sandboxed iframe** via `srcdoc`
  (`modules/customs/src/views/DocumentsView.vue`) rather than injected into the
  shell's DOM — so even self-generated HTML cannot reach the session.

## 16. Restrict file uploads — Open

No upload route is implemented yet. When one is added (product images are the
obvious first), it needs: an explicit allow-list of MIME types, a size cap below
the 2 MB body limit, content-sniffing rather than trusting the declared type, a
generated filename, and storage outside the served static root.

## 17. Trim API responses — Partial

`toAuthUser()` maps database rows to a narrow shape, so `passwordHash`,
`totpSecret` and `recoveryCodes` never leave the server. `PublishedModule.filePath`
is stripped by `toDescriptor()` so server paths are not disclosed. Logs redact
`authorization`, `cookie`, `password`, `totp`, `recoveryCode` and `apiKey`.

> **Gap:** there are no response schemas yet. Adding Fastify serialiser schemas
> would make trimming structural instead of a convention each route must follow.

## 18. Security headers — Done

`@fastify/helmet` in `app.ts` sets CSP, HSTS, referrer policy, COOP and CORP.
The CSP is worth reading closely:

```
scriptSrc: ["'self'", 'blob:']
```

`blob:` is required because runtime modules are executed as ES modules from a
blob URL. It is deliberately the **only** relaxation — no CDNs, no `unsafe-inline`
script, no `unsafe-eval`. Combined with §20 below, the only code that can run is
code this server published and the client hash-verified.

## 19. Force HTTPS — Done

An `onRequest` hook rejects non-HTTPS requests (honouring `x-forwarded-proto`
when behind a proxy), and HSTS is set with `includeSubDomains` and `preload`.
Disabling it is an explicit opt-out (`ZOLLIFY_REQUIRE_HTTPS=0`) intended only for
local HTTP development.

## 20. Scan dependencies — Done

`npm run audit:deps` runs `npm audit --audit-level=moderate`, and
`.github/workflows/ci.yml` runs it on every push and pull request as its own
job — so a newly-disclosed advisory reports as an audit failure rather than
masking a real regression in the build.

CI also typechecks, tests, and builds both the module bundles and the web app.
Building the modules in CI is deliberate: a module that compiles but fails to
bundle would otherwise only be discovered when someone tried to publish it.

This matters more than usual here — a compromised dependency inside a module
bundle executes in the user's session, in the same origin as their access
token.

---

## Beyond the checklist: runtime module integrity

Runtime loading introduces a risk the twenty points do not cover, so it gets its
own controls:

1. **Published hash.** The server hashes each bundle at boot (`modules/registry.ts`) and publishes the SHA-256.
2. **Verify before store.** `putCached()` refuses to write a bundle whose content does not match the published hash.
3. **Verify before execute.** `verifyCached()` re-checks on every load, so tampering with IndexedDB after the fact is caught too.
4. **Immutable per version.** Cache keys are `<moduleId>@<version>` and are never overwritten, so a half-written update cannot replace a working module mid-convention.
5. **Identity check.** The loader refuses a bundle whose declared `id` differs from the one the registry served it as — otherwise a swapped bundle could mount under another module's namespace, and therefore its database and HTTP prefix.
6. **No traversal.** Bundle file paths are resolved from the in-memory store, never from the request URL.

**Known and accepted:** a loaded module runs with full application privileges,
including the user's session. That is acceptable while every module is
first-party. It becomes the central problem the day the SDK is published to
third parties, and would need real isolation (a worker or iframe boundary with a
message-passing SDK) before that happens.
