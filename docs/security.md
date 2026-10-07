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

Public events lets an account share an event to a pool every account on the server can search and quick-add from. It is the only place event data leaves an account on purpose.

- **Opt-in, per event, reversible.** Nothing is shared until an admin shares that event. Withdrawing deletes the contribution; a listing with no contributors left is deleted with its flags and quick-add records.
- **What crosses** (the `PoolListing` shape in `packages/shared/src/event-pool.ts`): name, edition label, venue name, street, postcode, city, country, start and end date, an https link, a description of up to 400 characters, a count of accounts going, and display names only for contributors who typed one.
- **What never crosses**: costs, sales, stock, notes, attachments, VAT, customs data, account or user ids, account names, emails. Searches return no contributor ids.
- **The server picks every field.** Name, dates and address are read from the contributor's own event in the op-log, never from the request body. The request adds only edition, venue name, link, description and display name, each validated and length-limited.
- **No markup.** Text containing `<` or `>` is refused and control characters are stripped. Links must be https, without credentials. The client renders everything as escaped text.
- **Dedupe.** Listings match on normalised name (case, accents and punctuation ignored), start date and city. A match adds a contributor instead of a second listing. The listing shows the newest contributor's details.
- **Abuse controls.** 20 shares or edits per account per hour, 30 reports per account per day, 200 shared events per account, listings at most 60 days long. Each account can flag a listing once. Three distinct accounts flagging a listing hide it from search. Flags are stored in `event_pool_flags` and there is no admin screen for them yet; the server owner reads them from the database. Three colluding accounts could hide a listing, which is why hiding only affects search and the contributors keep their own copy.
- **Visibility.** Only signed-in accounts with the Public events module switched on can search the pool. It is not on the unauthenticated `/p/` routes.

## Settings

| Variable | Meaning |
|----------|---------|
| `ZOLLIFY_TRUST_PROXY` | `true` (default) trusts one reverse proxy in front; a number trusts that many hops; `false` trusts none. More than you have lets clients choose their own IP and step around rate limits. |
| `PUBLIC_ORIGIN` | The address people reach the server at (e.g. `https://pos.example.com`), used for links in emails. |
| `WEBHOOK_ALLOW_PRIVATE=1` | Lets webhooks reach private addresses. Only for LAN-only installs. |
| `CAPTCHA_BITS`, `SIGNUP_CAPTCHA_BITS`, `RECEIPT_CAPTCHA_BITS` | Proof-of-work difficulty; registration never accepts less than `CAPTCHA_BITS`. |

## Known limits

- A till's unlock lasts a shift (12 hours). Anyone at an unlocked till can act as that person within the limits above. Lock the till when stepping away.
- A refresh token replayed after its 30-second reuse grace is refused, but this does not end the rest of that session.
- Admins can still credit a sale to any colleague by hand. That is a trust decision, not a technical control.
