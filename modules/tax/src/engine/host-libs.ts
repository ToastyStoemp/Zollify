/**
 * The heavy libraries this module needs only now and then - the PDF builder
 * and the spreadsheet reader, ~900 kB between them.
 *
 * They are not in the module's bundle. The shell provides them (its import map
 * points `jspdf`, `jspdf-autotable` and `xlsx` at its own lazy files) and they
 * are imported here, on first use, so opening the app costs nothing for an
 * export nobody asked for. Each import() is written out literally: that is
 * what lets the bundled build split them into chunks of their own.
 */

/** A library could not be loaded. The message is written for the person at the screen. */
export class HostLibraryError extends Error {
  constructor(what: string, cause: unknown) {
    super(explain(what, cause), { cause });
    this.name = 'HostLibraryError';
  }
}

/**
 * Two things go wrong. A shell from before it provided these libraries has
 * nothing to resolve the name with ("Failed to resolve module specifier") -
 * only an app update fixes that. Anything else is the file not arriving.
 */
function explain(what: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (/specifier/i.test(detail)) return `This version of the app cannot ${what} - update the app, then try again.`;
  return `Could not load what is needed to ${what} - check the connection and try again.`;
}

async function load<T>(what: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (err) {
    throw new HostLibraryError(what, err);
  }
}

export interface PdfLibs {
  jsPDF: typeof import('jspdf').jsPDF;
  autoTable: typeof import('jspdf-autotable').default;
}

export async function loadPdfLibs(): Promise<PdfLibs> {
  return load('create PDFs', async () => {
    const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
    return { jsPDF, autoTable };
  });
}

export function loadXlsx(): Promise<typeof import('xlsx')> {
  return load('read spreadsheets', () => import('xlsx'));
}
