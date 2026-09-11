/**
 * Date-times are written to the sheet as `YYYY-MM-DD HH:MM:SS` in UTC. Google
 * Sheets parses that format as a native date-time when appended with the
 * USER_ENTERED option, and it sorts correctly as text too.
 */
const SHEET_DATE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

export function formatSheetDate(iso: string | Date): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a valid date: ${String(iso)}`);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Inverse of `formatSheetDate`. Returns undefined for anything that is not in the sheet format. */
export function parseSheetDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const match = SHEET_DATE.exec(value);
  if (!match) return undefined;
  const date = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Midnight UTC at the start of a `YYYY-MM-DD` date. */
export function startOfUtcDay(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}
