# Setting up the fiskaly cloud TSE

German law (KassenSichV) requires every sale on an electronic till in Germany to be signed by a certified
technical security device (TSE). Zollify supports two kinds:

- **fiskaly cloud TSE** (this guide): no hardware. Every device - Carbon, phones, tablets - signs through Zollify's
  server, which talks to fiskaly. Every sale needs an internet connection. fiskaly charges per till per month, and
  each device that signs counts as a till.
- **Swissbit TSE** (USB or microSD stick in the device): a one-off purchase, works offline, other devices can sign
  through it. See [`tse-swissbit.md`](tse-swissbit.md).

Setting it up takes about fifteen minutes. Start in fiskaly's free TEST environment, and switch to LIVE when you're
ready to sell.

## Before you start

- You are the owner or an admin of the Zollify account.
- Germany is switched on: **Settings → Modules → Built in → Germany (KassenSichV) → Switch on**.
- Your booth profile has your business name, address and VAT number (Settings → Booth profile) - German receipts
  must show them.

## 1. Create a fiskaly account

1. Sign up at [dashboard.fiskaly.com](https://dashboard.fiskaly.com).
2. Create your **organisation** with your business details (name, address, tax number / VAT ID).
3. Stay in the **TEST** environment for now. It is free, and works exactly like LIVE except that its signatures are
   not certified.

## 2. Create an API key

1. In the fiskaly dashboard, open your organisation and create an **API key** for the TEST environment.
2. Copy the **key** and the **secret**. The secret is shown only once - if you lose it, create a new key.

## 3. Connect Zollify

1. In Zollify: **Settings → TSE (fiskaly cloud)**.
2. Paste the key and the secret and press **Save key**. Zollify checks them with fiskaly before saving, then keeps
   them encrypted on the server. Devices never see them, and they are never shown again.

## 4. Set up the TSE

Press **Set up TSE**. Zollify creates your TSE at fiskaly (fiskaly calls it a TSS) and initialises it. This can take
up to a minute. The TSE's admin PUK and PIN are generated and kept encrypted alongside the key - you don't need them
for anything in Zollify.

When it says **Ready**, the TSE serial number appears on the page.

If setup stops halfway (a network error, say), press the button again - it carries on from where it stopped.

## 5. Choose fiskaly on every device that sells

On each device - the Carbon and every phone:

1. **Settings → This device → TSE → fiskaly cloud TSE**.
2. Check the **till serial number** under it. Each device has its own; the default (`ZOLLIFY-…`) is fine. It is
   printed on receipts and given to the tax office, and may not contain `/` or `_`.
3. Leave **Sign** on "Sales at events in Germany".

A device registers itself with your TSE the first time it signs.

## 6. Try it

Open an event whose country is **Germany** and make a sale. The receipt shows a TSE block (transaction number,
signature counter, start and end, TSE serial) and a QR code. In TEST it also says **TEST-TSE - NICHT ZERTIFIZIERT**.

Sales at events outside Germany are not signed.

## 7. Go live

1. Activate your fiskaly contract (LIVE environment) and create a **LIVE API key** in the dashboard.
2. In Zollify, **Settings → TSE (fiskaly cloud)**: paste the LIVE key and secret and press **Replace key**.
3. Press **Set up TSE** again. A LIVE key gets a TSE of its own - your TEST TSE stays in TEST.
4. Make a test sale: the receipt no longer says TEST.

## 8. Tell the tax office

Within one month of starting (and of stopping) use, report the tills in **ELSTER** ("Mitteilung über elektronische
Aufzeichnungssysteme nach § 146a Abs. 4 AO"):

- each device's **till serial number** (Settings → This device → TSE);
- the **TSE serial number** (Settings → TSE (fiskaly cloud));
- the TSE type: **cloud TSE, fiskaly SIGN DE**;
- the date you started using them.

## When something goes wrong

- **No connection at the booth**: the sale still goes through; the receipt says "TSE ausgefallen" and the sale keeps
  the reason. The rules allow this only temporarily - get the connection back. The Carbon's mobile data or a phone
  hotspot helps.
- **"The fiskaly TSE is not set up"**: finish step 4.
- **"Invalid credentials"**: the key or secret is wrong, or was deleted in the dashboard - create a new key and save it.
- **Inspection**: Settings → Tax export (Germany) gives the DSFinV-K export. fiskaly keeps the TSE's own records;
  its TAR export is available from the fiskaly dashboard.
