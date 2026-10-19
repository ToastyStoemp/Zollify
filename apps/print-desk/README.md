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

On Windows, double-click **Print Desk.cmd** in this folder (or a shortcut to
it on the desktop). It installs the dependencies on first run, then builds and
starts the app; its console window stays open while the app runs.

From a terminal at the repo root:

```bash
npm run start -w @zollify/print-desk
```

Both build the renderer (Vite) and the main process (tsc) and start Electron.

## How it works

- Sign-in is the shell's: `/api/auth/login` as a native client, or by QR
  (`/api/auth/link/start` + `poll`, approved from a signed-in phone under
  Settings → Account & security → Sign in another device). The refresh token
  is kept in the OS keychain through Electron's `safeStorage`.
- The catalogue is the account's op log (`/api/sync/pull`), reduced to one row
  per product or variant with its counted stock (`inventory.set`).
- A file is linked with **Link a file**, or by dragging it from File Explorer
  onto the row (PSD, PSB, PCRAFT, PNG, JPG, TIFF, WebP).
- Each row's file and `file.print` params live in `print-desk.json` in the app's
  user-data folder, keyed by account and `productId:variantId`. The JSON box in
  a row's settings takes any further PhotoCraft print param as it is, including
  `printerSettings` (the Windows driver settings PhotoCraft's Print Settings
  dialog gives you) and `printerProfile`.
- **Detect sizes** sets each item's paper from an A0-A6 size in its variant
  name, else its product name ("A3", "Poster a4"; not "A3+"). A3-A5 go to
  PhotoCraft by name, the other A sizes as points.
- A row's settings can be applied to **all items of its size** (everything,
  driver settings included) or to **all items**: there, items of another size
  keep their own paper and get no `printerSettings`, because those carry the
  driver's paper and PhotoCraft refuses a driver paper that differs from the
  layout. So: set one item per size up with its driver settings, then apply
  it to that size. Linked files are never touched.
- **Print all** runs one `file.print` per queued row with `copies` set, then
  pushes an `inventory.set` op per printed row with the old count plus the
  copies - the same op a stock count in the web app makes. Stock counts what
  was sent; a job cancelled in the print queue afterwards is not taken back.
- On Windows, each job is then followed in the print queue (`Win32_PrintJob`,
  every 2 s) until it leaves it. PhotoCraft prints every copy as one page of
  the job, so pages printed is copies done; the row shows a bar, the driver's
  status and printer problems (no paper, offline...), and the toolbar the
  copies left in the whole run. "Printed" is what the driver has sent to the
  printer. Elsewhere a job shows as sent, without progress.
