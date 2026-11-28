/**
 * Host-provided SheetJS, loaded on demand - see ./jspdf.ts for why. At ~500 kB
 * it is the largest library in the app and only ever needed when a spreadsheet
 * is picked.
 */
export * from 'xlsx';
