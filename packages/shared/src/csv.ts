/**
 * One CSV field. Text starting with = + - @ (or a tab or carriage return) is
 * read as a formula by Excel and Sheets, so a product or artist named
 * "=HYPERLINK(...)" would run when the file is opened: such text gets a
 * leading apostrophe, which the spreadsheet hides. Numbers stay numbers.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The address if it is an http(s) link, else '' - a javascript: or data: "link" never reaches an href. */
export function safeHttpUrl(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : '';
  } catch {
    return '';
  }
}
