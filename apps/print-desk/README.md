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
  own; otherwise point the app at `photocraft-cli` with **Browse**.
- A Zollify account on a server you can reach. Sign in as an owner or admin:
  staff cannot change the inventory.

## Run

```bash
npm run start -w @zollify/print-desk
```

That builds the renderer (Vite) and the main process (tsc) and starts Electron.

## How it works

- Sign-in is the shell's: `/api/auth/login` as a native client, or by QR
  (`/api/auth/link/start` + `poll`, approved from a signed-in phone under
  Settings → Account & security → Sign in another device). The refresh token
  is kept in the OS keychain through Electron's `safeStorage`.
- The catalogue is the account's op log (`/api/sync/pull`), reduced to one row
  per product or variant with its counted stock (`inventory.set`).
- Each row's file and `file.print` params live in `print-desk.json` in the app's
  user-data folder, keyed by account and `productId:variantId`. The JSON box in
  a row's settings takes any further PhotoCraft print param as it is, including
  `printerSettings` (the Windows driver settings PhotoCraft's Print Settings
  dialog gives you) and `printerProfile`.
- **Print all** runs one `file.print` per queued row with `copies` set, then
  pushes an `inventory.set` op per printed row with the old count plus the
  copies - the same op a stock count in the web app makes.
