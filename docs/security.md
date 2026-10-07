# Security notes

What the server guarantees, and the settings that matter for it. Regression tests for each point are in `packages/server-core/src/__tests__/security.test.ts` and `apps/server/src/__tests__/tax-endpoints.test.ts`.

## Accounts and sessions

- **Tokens are checked against the database on every request.** A removed person's token stops at once, and the role is always the current one, never the one from when they signed in.
- **Shared tills**: a person unlocked at a till gets a token tied to that device. It works only while they are unlocked there. It cannot:
  - create invites, API tokens or webhooks
  - change 2FA, manage sessions or devices
  - switch modules or change integration keys
  - delete anything account-wide
- **PIN guessing**: each guess is counted, and the lock set, in one database statement before the PIN is checked, so guesses sent in parallel cannot slip past the lockout.
- **Sale attribution**: a sale is credited to a colleague only when the push comes from a till they are added to and the pusher really has a session on that till.
- **2FA**: setting up a new authenticator while 2FA is on takes the current code. Recovery codes are single-use, also under races.
- **Account deletion**: admins only. The server owner's own account can only be deleted by the server owner.
- **First-run setup** ("first visitor becomes owner") never reopens once anyone has signed up.
- **Refresh tokens** go in the response body only for the native app (Capacitor origins). A script in the browser always gets the HttpOnly cookie instead.

## Bots and abuse

- The CAPTCHA key is derived from the server secret. Every challenge must ask for a minimum amount of work, whatever the challenge itself says.
- Invite codes are 16 characters, about 80 bits.
- Requests without a token may not send bodies over 256 KB.
- Log uploads are rate-limited, and each account keeps only its newest 30.

## Public pages with personal data

- **Commission tracking** (`/p/commissions/<token>`): the token is 24 random bytes, one per commission, and an admin can replace it (the old link then answers "not available"). The page is built from a fixed list of fields (title, status, updates written for the customer, due date, amounts, pickup address); contact details, details and internal notes never leave. It is rendered on the server with every value escaped, has no script, is rate limited per IP, and is `noindex`, `no-store` and `no-referrer`. A wrong, malformed or retired token and a disabled module all give the same answer. Customer details live in the module's own server tables, not in the synced op-log, and an admin can erase a commission.

## Commission customers (personal data, kept only while needed)

A customer's name, email and phone are stored once per customer in `commission_customers` (server only, never in the op-log); commissions point at the customer by id and carry none of these fields. Nothing personal is logged.

- **When details are needed.** While the customer has at least one commission that is not Collected or Cancelled. A closed commission cannot be reopened in the app, and a new commission for the customer makes them needed again; the clock restarts when it closes.
- **Retention.** Admin setting "Keep customer details after the last commission closes", in days, default 30, 0 to 365 (0 erases at the next sweep). The clock starts when the last commission closed, or when the customer was added if they have none.
- **The sweep.** Runs when the server starts and every 3 hours, only for accounts with the Commissions module switched on (a switched-off module is left alone until it is switched on again). It is idempotent. It is the only automatic erasure; the setting is read each time, so lowering it applies at the next run.
- **What erasing does.** Deletes the customer record (name, email, phone). On each of their commissions it clears the internal notes, the free-text details and the messages written for the customer (free text can name or describe a person, and none of it is needed for the books), blanks the customer link, and shows the neutral label "Customer removed". It keeps the title, price, deposit asked, currency, due date, status, the date and step of every timeline entry, the tracking link, and what was paid (derived from sales, which stay in the books). The title is kept as the commission's label in the books, so it should not carry a person's name; the form says it is shown to the customer.
- **Manual erasure.** "Erase now" on a customer and "Erase all closed customers now" are admin only, ask for confirmation that lists what is deleted, are refused for a customer with an open commission, and are denied on a shared till.
- **Existing data.** Commissions made before customer records are moved onto them at startup (same email in any case, else same phone digits, else one customer each), nothing is lost, and the move is idempotent. Migrated customers start their retention clock at the migration, so nothing is erased on the day of deploy; commissions closed long ago are erased once the retention period after the migration has run.
- **Search.** Name, email or phone, scoped to the caller's account in the query, at least two characters, at most 8 results, rate limited, and it returns contact fields only. A customer id from another account is treated as unknown.
- **Duplicates.** A new customer whose email (any case) or phone digits match an existing one is offered back instead of created; staff choose to use the existing customer or add a new one anyway. Nothing is merged automatically.
- **Email.** Messages to the customer go out only while the customer exists and has an address. The public tracking page never showed contact details and does not need the customer, so it keeps working after erasure (without the customer messages).

## File uploads

One mechanism covers every upload: event files, ledger invoices, invoice scanning, voucher PDFs, sourcing design files and proofs, and the receipt logo. The rules live in `packages/shared/src/upload-limits.ts` (the app checks them before sending) and `packages/server-core/src/upload-limits.ts` (the server enforces them). Tests: `packages/shared/src/__tests__/upload-limits.test.ts`, `packages/server-core/src/__tests__/upload-limits.test.ts`, `apps/server/src/__tests__/uploads.test.ts`.

- **The real type is read from the file's first bytes.** The browser's Content-Type and the file's name are only checked against it: a PDF called `.png`, or an image that says it is a PDF, is refused with a 415, and the type that is stored is the one the bytes prove.
- **HTML, SVG and XML are never accepted**, whatever they are called or labelled, and neither are names ending in `.html`, `.svg`, `.js` or `.exe`.
- **Limits** (a picture 5 MB, a PDF 10 MB, the invoice scanner 5 MB, a design file 25 MB, the receipt logo 256 KB) are checked per type. A request body over its route's limit is refused from its Content-Length, before any of it is read.
- **Storage quota**: event files, ledger invoices and sourcing files together count toward one limit per account, and an event holds a fixed number of files.
- **Errors are readable**: 400 (empty or unreadable), 413 (too large, with the limit), 415 (wrong type, with what is allowed).
- Imports (backups, the ZollTool zip, payments exports) are read in the browser and never uploaded as files; their size caps protect the device.
- A stored file is never served as a raw URL. If a route ever does, `downloadHeaders()` makes it a download, with `nosniff` and a sandboxing CSP.

## Outgoing requests (SSRF)

- **Webhooks**: public https addresses only. Loopback, private, link-local, carrier NAT, benchmark ranges and IPv6 forms that wrap them are refused. The address is checked again when connecting, so DNS rebinding does not help, and only a few KB of the answer is read.
- **Integrations** (Lexware, myPOS, SumUp, Shopify): only the providers' own hosts, and no redirects.
- **Peppol**: Storecove's fixed address only. The Peppol Directory lookup accepts strict identifiers only.
- **Nexi SmartPOS**: Poynt's fixed API host only (services-eu.poynt.net, or services.poynt.net). The terminal's callbacks only count on the per-payment URL Poynt was given (a random secret in the path), only for the exact amount and currency asked, and a final outcome is never overwritten. Each account's own Poynt app key is stored encrypted, never sent back to a browser, and only owners and admins can change it. Connecting a Nexi account takes a one-time context we issued, a fresh code made out to this app (signature checked when `POYNT_AUTH_PUBLIC_KEY` is set), Poynt confirming the app can see that business, and a business links to one account only.

## Output

- CSV exports neutralise spreadsheet formulas (`=`, `+`, `-`, `@`, tab, CR).
- Links that come from account data are rendered only when they are http(s).
- Slack and Discord messages escape link and mention syntax.
- Email links use `PUBLIC_ORIGIN`, or forwarded headers only from a trusted proxy.

## Shared event pool (data that crosses accounts)

Public events lets an account share its events to a pool every account on the server can search and quick-add from. It is the only place event data leaves an account on purpose.

- **Account-level consent, off by default.** One setting, "Help share event information with the community" (setup wizard for accounts that run events, Settings, Event sharing, and the top of Find events). Nothing is shared until an owner or admin turns it on; existing accounts stay off. Turning it off withdraws every contribution of the account at once. A single event can opt out ("Do not share this event with the community") for private or invite-only events.
- **What is shared when it is on.** Only events (never stores) that have a name, valid dates of at most 60 days, and a city or country, from 30 days ago onward. The server reconciles the account's contributions with its op-log whenever its events change, so edits update the listing and a deleted, opted-out or aged-out event is withdrawn.
- **What crosses** (the `PoolListing` shape in `packages/shared/src/event-pool.ts`): name, edition label, venue name, street, postcode, city, country, start and end date, an https link (the event's booth link), and a description of up to 400 characters (the event's note for visitors, which the public page already shows). Nothing else.
- **What never crosses**: costs, sales, stock, notes, attachments, booth hall and number, VAT, customs data, account or user ids, account names, emails.
- **Who goes stays private.** There is no count of accounts, no display names, no contributor ids and no timestamps in any response. The server keeps an account id on each contribution only so the account's own contributions can be updated, withdrawn and deduped; it is never returned. A listing shows the facts of its first contribution, so another account joining or leaving never changes it, and a listing shared by many accounts looks exactly like one shared by a single account. Search order (soonest start, then name), paging and error messages do not depend on how many accounts share a listing. Quick-add is recorded for the adopting account only and no other account can see it. The one thing a caller learns is about itself: its own and already-added listings are left out of its search.
- **Quick-add is open to everyone.** Find events and quick-add work whether or not the account shares; there is no reciprocity requirement.
- **The server picks every field.** Name, dates, address, link and description are read from the contributor's own events in the op-log, never from a request body; each is validated and length-limited.
- **No markup.** Text containing `<` or `>` is refused and control characters are stripped. Links must be https, without credentials. The client renders everything as escaped text.
- **Dedupe.** Listings match on normalised name (case, accents and punctuation ignored), start date and city (or country when there is no city). A match adds a private contribution instead of a second listing.
- **Abuse controls.** 20 consent changes per account per hour, 30 reports per account per day, 200 shared events per account, listings at most 60 days long. Each account can flag a listing once. Three distinct accounts flagging a listing hide it from search. Flags are stored in `event_pool_flags` and there is no admin screen for them yet; the server owner reads them from the database. Three colluding accounts could hide a listing, which is why hiding only affects search and the contributors keep their own copy.
- **Visibility.** Only signed-in accounts with the Public events module switched on can search the pool. It is not on the unauthenticated `/p/` routes.
- **Migration.** Display names from the earlier per-event sharing are dropped. Contributions made under it are withdrawn unless the account has since agreed to the new setting.
- **Known limit.** Contributions stay in the pool while the Public events module is switched off for an account; turn sharing off first to withdraw them.

## Settings

| Variable | Meaning |
|----------|---------|
| `ZOLLIFY_TRUST_PROXY` | `true` (default) trusts one reverse proxy in front; a number trusts that many hops; `false` trusts none. More than you have lets clients choose their own IP and step around rate limits. |
| `PUBLIC_ORIGIN` | The address people reach the server at (e.g. `https://pos.example.com`), used for links in emails. |
| `WEBHOOK_ALLOW_PRIVATE=1` | Lets webhooks reach private addresses. Only for LAN-only installs. |
| `ZOLLIFY_ACCOUNT_STORAGE_MB` | Stored attachments one account may keep in total, in MB (default 500). |
| `ZOLLIFY_EVENT_FILES_MAX` | Files one event may hold (default 20). |
| `ZOLLIFY_MAX_BODY_MB` | Request body limit for routes that take no file, in MB (default 8). Routes that take a file set their own. |
| `CAPTCHA_BITS`, `SIGNUP_CAPTCHA_BITS`, `RECEIPT_CAPTCHA_BITS` | Proof-of-work difficulty; registration never accepts less than `CAPTCHA_BITS`. |

## Known limits

- A till's unlock lasts a shift (12 hours). Anyone at an unlocked till can act as that person within the limits above. Lock the till when stepping away.
- A refresh token replayed after its 30-second reuse grace is refused, but this does not end the rest of that session.
- Admins can still credit a sale to any colleague by hand. That is a trust decision, not a technical control.
