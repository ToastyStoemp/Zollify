# Swissbit TSE: the native driver still to build

Zollify signs sales in Germany through a TSE in the device (KassenSichV). Everything around the TSE is in
place - starting a transaction at a sale's first item, signing the finished sale over the exact figures on the
receipt, cancellations as signed negative receipts, outage handling, the receipt's TSE block and QR code, and
the device settings (Settings → This device → TSE). A **test TSE** (software, not certified) runs the whole flow
today.

What is missing is the Android plugin that talks to a real **Swissbit TSE**. It needs Swissbit's SDK, which
Swissbit only provides with the TSE itself, so it is the next step once one is bought.

## Hardware

- **myPOS Carbon**: Android 9, one SD 3.0 slot and one USB-C OTG port - takes a Swissbit **microSD** TSE or a
  **USB** TSE through OTG.
- **Phones/tablets on Android 11+**: microSD TSEs no longer work there (Android storage changes); use the
  **USB** TSE through OTG.
- Payment terminals (myPOS Go 2, SumUp Air/Solo, the Carbon's own payment app) do not provide a TSE. The TSE
  belongs to the till software - Zollify - whichever terminal takes the card.

## The plugin contract

Implement a Capacitor plugin named **`SwissbitTse`** (Kotlin, `android/app/src/main/java/...`, registered in
`MainActivity` like the other plugins) with these methods. The TypeScript side is
`packages/platform/src/core/tse.ts` (`swissbitDriver`).

| Method | Arguments | Returns | Swissbit WORM API |
|---|---|---|---|
| `isAvailable()` | - | `{ available: boolean }` | `worm_init` on the TSE's mount point / USB device; self-test |
| `info()` | - | `{ serial, publicKey, algorithm, timeFormat, certified: true, expires?, certificate? }` | `worm_info_*`: serial number (hex SHA-256 of the public key), public key (base64), signature algorithm (e.g. `ecdsa-plain-SHA384`), log time format (`unixTime`), certificate expiry |
| `startTransaction({ clientId })` | till serial | `{ transactionNumber, logTime }` (logTime in ms) | `worm_transaction_start(clientId, processData = "", processType = "")` |
| `finishTransaction({ clientId, transactionNumber, processType, processData })` | as named | `{ signatureCounter, logTime, signature }` (signature base64) | `worm_transaction_finish(...)` |

Also needed once, at setup and on the TSE's own schedule:

- **Initialisation and client registration**: set up the TSE (PINs/PUK, time admin) and register the till's
  serial number (`clientId`, shown in Settings) as a client.
- **Time**: update the TSE's clock from the device (`worm_tse_updateTime`) before transactions.
- **Export**: the TSE's TAR export (`worm_export_tar`) for a tax inspection - add an "Export TSE data" button
  next to "Check TSE" that saves the TAR file.

**Several tills on one TSE.** A main TSE device also signs for the account's devices without a TSE (a backup
phone, say), each under its own till serial number (`clientId`). The plugin must therefore accept any `clientId`:
when `startTransaction` gets one the TSE does not know yet, register it as a client first
(`worm_tse_registerClient`) and carry on. Each of those tills is registered with the tax office too.

**Certificate.** The DSFinV-K export's tse.csv carries the TSE's certificate (base64). Return it from `info()` as
`certificate` and add it to the export (TSE_ZERTIFIKAT_I…) - today those fields are empty.

Errors should reject the call with a readable message; Zollify records it as a TSE outage on the sale
("TSE ausgefallen") and keeps selling, as the rules require.

## After the plugin exists

1. Pick "Swissbit TSE" under Settings → This device → TSE, set the till serial number, press "Check TSE".
2. Register the till and TSE with the tax office via ELSTER within one month (see `germany-compliance.md`).
3. Add the DSFinV-K export (the TSE signs; the DSFinV-K export is the till's own data in the format the tax
   office reads).
