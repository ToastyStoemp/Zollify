/**
 * The calendar day of a moment as the device sees it (YYYY-MM-DD).
 *
 * NOT `toISOString().slice(0, 10)`: that converts to UTC first, so between
 * local midnight and UTC midnight "today" would be yesterday. Use `localDay`
 * from consignment-books when a specific store time zone is known instead.
 */
export function localIsoDay(d: Date | number = Date.now()): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
