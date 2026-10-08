# Security review — 6 October 2026

Reviewed revision: `f8c1e48`. Fix branch: `codex/security-audit-fixes`.

## Outcome and scope

Five security findings were identified and fixed locally: one high and four medium severity. Severity is a qualitative assessment of prerequisites and impact, not a calculated CVSS score. These changes have not been deployed.

The review focused on the Node/Fastify gateway: authentication and refresh transport, account/event access controls, sync ingestion and pagination, WebSocket sessions, file routes, module authorization, and selected external-service integrations. Existing security tests were inspected and the two server test suites were run. The npm advisory service reported **zero known dependency vulnerabilities** for the lockfile on the review date.

All exploit validation used temporary local SQLite databases and Fastify injection. No requests were sent to zollify.app, no production data was read or changed, and no external emails or webhooks were sent by the new tests. This is a focused source review, not an exhaustive penetration test or assurance that the entire application is vulnerability-free. Production proxy configuration, infrastructure, secret management, Android storage and the full browser/module surface were not independently audited.

## Findings

### SEC-01 — High: event-restricted users could revert another event's sale

**Location:** `packages/server-core/src/routes/sync.ts`, sync push authorization.

**Prerequisites:** A valid event-restricted account member and knowledge of a transaction ID belonging to another event in the same account. This is an intra-account authorization bypass, not a cross-tenant exploit.

**Reproduction:** Store sale `foreign-sale` under a private event. As a helper restricted to `allowed`, submit a batch containing a new `tx.create` with the same sale ID but event `allowed`, followed by `tx.revert` with `txId: "foreign-sale"`. Previously the permission check trusted the in-batch duplicate while transaction reduction retained the original first sale. The refund operation was accepted against the private event's sale.

**Impact:** Unauthorized ledger cancellation outside the user's assigned events. This does not itself demonstrate a refund through a payment processor.

**Fix:** Authorize each operation inside the insertion transaction against the first persisted sale ordered by sequence. Legitimate sales accepted earlier in the same batch remain refundable; duplicates and dropped operations cannot override the canonical sale used for authorization. Refund reads/writes consistently support both `id` and legacy `txId` payload fields.

**Evidence:** The new regression stored an unauthorized refund before the fix and now stores none. Positive tests preserve permitted refunds in both payload formats.

### SEC-02 — Medium: anonymous request-size protection was bypassable

**Location:** `packages/server-core/src/app.ts`; new `body-limit.ts`.

**Reproduction:** POST a JSON body larger than 256 KiB to `/api/auth/login` with `Authorization: Bearer fake`, or stream it without Content-Length. Previously both requests reached schema validation because the guard checked only the presence of an authorization header and the declared length.

**Impact:** An anonymous caller could force parsing of bodies up to the larger route limit (normally 32 MiB), increasing memory and CPU pressure. The existing global body limit and rate limiting still bounded individual requests; unlimited body acceptance was not observed.

**Fix:** Validate the JWT and current user/till state, or an active scoped API token, before granting the larger allowance. Otherwise enforce 256 KiB on both declared and actual streamed bytes before JSON parsing. Route-level maximums remain in effect. WebSocket upgrades are preserved.

**Evidence:** Forged-header and streamed requests previously returned schema errors (400), now return 413. Tests also cover removed users, revoked API tokens, active write tokens, and large legitimate sync requests.

### SEC-03 — Medium: negative sync page sizes disabled the database row limit

**Location:** `packages/server-core/src/routes/sync.ts`, `/api/sync/pull`.

**Reproduction:** An authenticated caller requests `?since=0&limit=-1`. The former upper-bound-only calculation passed a negative LIMIT to SQLite, which means no row limit.

**Impact:** A caller could trigger a full account log load, parsing, serialization and potentially synchronous compression in a single request. Large logs could exhaust memory or block the shared server. Event filtering occurred after the database read, so restricted users could also trigger this work. This does not bypass tenant filtering.

**Fix:** Require a nonnegative safe-integer cursor and a positive safe-integer page size, retaining the 1,000-row cap. Invalid parameters return 400.

**Evidence:** Regression tests cover negative, fractional, infinite and zero page sizes and invalid cursors. Existing valid-pagination tests pass.

### SEC-04 — Medium, deployment-dependent: HTTPS guard trusted untrusted forwarding headers

**Location:** `packages/server-core/src/app.ts`, HTTPS enforcement.

**Reproduction:** With HTTPS required and proxy trust disabled, send plain HTTP with `X-Forwarded-Proto: https`. The guard explicitly preferred that header over the server's request protocol.

**Impact:** A client able to reach the backend directly could bypass its intended transport rejection. Exposure depends on network reachability and deployment configuration; HTTPS at the public proxy was not tested or shown to be bypassable.

**Fix:** Use Fastify's `req.protocol`, which applies the configured proxy behavior, rather than independently trusting the raw header. When proxy trust is enabled, the backend still needs to be reachable only through the intended proxy.

**Evidence:** Tests reject spoofed forwarding headers with proxy trust disabled, permit the configured proxy path, and reject plain requests without forwarded HTTPS.

### SEC-05 — Medium: WebSocket authorization was checked only at connection time

**Location:** `packages/server-core/src/ws.ts`.

**Prerequisites:** A previously authorized open WebSocket.

**Impact:** Removing a user, allowing the JWT to expire, or ending a till authorization did not revoke the existing connection's ability to send/receive application messages. This affected customer-display carts, notifications, sync nudges and payment-message relays; HTTP endpoints still performed their own authorization.

**Fix:** Revalidate JWT expiration and current database claims before each incoming application message and each room delivery. Invalid sockets close with code 4001 before that message is relayed. An idle invalid socket can remain connected until application traffic occurs, but is no longer authorized to exchange that traffic.

**Evidence:** Integration tests remove a user after opening a socket and verify closure both when that socket sends and when a broadcast would be delivered to it. Existing display/relay tests pass.

## Validation and compatibility

- Before the initial fixes, five of the six initial regression tests failed, confirming the refund bypass, missing legitimate refund format, invalid pagination acceptance, forged-header body bypass and streamed-body bypass. The large authenticated upload control passed.
- Both full server suites passed after fixes: 89 server-core tests and 116 server application tests. Two additional WebSocket revocation tests were subsequently added; the final dedicated regression file passed all 10 tests.
- Server-core and server TypeScript checks passed. `git diff --check` passed.
- `npm audit --json` completed successfully with zero advisories. Missing local dependencies were installed to enable testing; dependency versions were not intentionally changed.
- Testing exposed Windows cleanup failures because gateway shutdown left SQLite open. The gateway now closes its database during shutdown, allowing the existing tests to remove their temporary databases successfully.

Behavior changes: invalid sync cursors/page sizes now return 400; large anonymous bodies return 413; expired/revoked sockets close on their next application message; restricted refunds must follow their sale in a batch. Normal authenticated uploads, native/browser refresh transport, staff authorization, module APIs and display relays passed the existing server suites.

## Deployment

Review and deploy the branch through the normal server deployment process. No database migration is required. Until deployed, these local fixes do not protect the live service. After deployment, smoke-test sign-in/refresh, sync, large authenticated uploads and customer-display reconnection with dedicated test accounts. Keep the backend port restricted to the intended reverse proxy when proxy trust is enabled.
