/**
 * Metrics exchange date-times with the sink as `YYYY-MM-DD HH:MM:SS` in UTC.
 * The Sheets sink recognises this shape, stores it as a native date-time
 * (`toSheetSerial` + `SHEET_DATE_PATTERN`) and reads it back as the same text,
 * which also sorts chronologically as a plain string.
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

/** Number format pattern that displays a serial date-time in the same shape as `formatSheetDate`. */
export const SHEET_DATE_PATTERN = "yyyy-mm-dd hh:mm:ss";

export const MS_PER_DAY = 86_400_000;
/** Days between the Sheets epoch (1899-12-30) and the Unix epoch. */
const SHEETS_EPOCH_OFFSET_DAYS = 25_569;

/**
 * Converts a date to a Google Sheets serial number (days since 1899-12-30,
 * fractional part is the time of day). Written as a number and paired with
 * `SHEET_DATE_PATTERN`, the cell is a native date-time the sheet can sort,
 * filter and chart, and it reads back as `formatSheetDate` text.
 */
export function toSheetSerial(date: Date): number {
  return date.getTime() / MS_PER_DAY + SHEETS_EPOCH_OFFSET_DAYS;
}

/** Midnight UTC at the start of a `YYYY-MM-DD` date. */
export function startOfUtcDay(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}
