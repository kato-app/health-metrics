import type { CellValue, Metric, MetricRow } from "../../core/metric.js";
import { SHEET_DATE_PATTERN, parseSheetDate, toSheetSerial } from "../../core/sheet-date.js";
import type { MetricSink } from "../../core/sink.js";
import type { Logger } from "../../logging/logger.js";
import { columnsRange, headerRange } from "./a1.js";
import type { Cell, SpreadsheetClient } from "./spreadsheet-client.js";

/**
 * Stores each metric in a tab named after it, with the metric's columns as the
 * header row.
 *
 * A metric owns only its own columns, starting at A. Everything is read from
 * and appended within that block, so people can add helper columns and
 * formulas to the right of the data without breaking the header check or
 * pushing new rows below their formulas.
 *
 * Encoding: rows are written RAW so Sheets never reinterprets text as a number,
 * date or formula. Cells in sheet-date format are the exception: they become
 * native date-time serials, and their columns are given a matching number
 * format after every write, so they read back as the same text.
 *
 * A sink instance lives for one CLI run, so it remembers the spreadsheet's tab
 * list and which headers it has already verified. The runner's read-then-append
 * sequence therefore costs one `listTabs` for the whole run and no second read
 * of the header before appending.
 */
export function createSheetsSink(client: SpreadsheetClient, logger: Logger): MetricSink {
  const log = logger.child({ sink: "google-sheets" });
  let tabs: Map<string, number> | undefined;
  const verifiedHeaders = new Set<string>();

  async function loadTabs(): Promise<Map<string, number>> {
    return (tabs ??= await client.listTabs());
  }

  function assertHeader(metric: Metric, header: readonly string[]): void {
    const expected = metric.columns;
    const matches = header.length === expected.length && expected.every((c, i) => header[i] === c);
    if (!matches) {
      throw new Error(
        `Tab "${metric.name}" has columns [${header.join(", ")}] but the metric expects [${expected.join(", ")}]`,
      );
    }
    verifiedHeaders.add(metric.name);
  }

  async function writeHeader(metric: Metric): Promise<void> {
    await client.appendValues(metric.name, columnsRange(metric.columns.length), [[...metric.columns]]);
    log.info("Wrote header", { tab: metric.name });
    verifiedHeaders.add(metric.name);
  }

  /** Returns the tab's sheet id, creating the tab and its header row if needed. */
  async function ensureTabWithHeader(metric: Metric): Promise<number> {
    const known = await loadTabs();
    let sheetId = known.get(metric.name);
    if (sheetId === undefined) {
      sheetId = await client.addTab(metric.name);
      known.set(metric.name, sheetId);
      log.info("Created tab", { tab: metric.name });
      await writeHeader(metric);
    } else if (!verifiedHeaders.has(metric.name)) {
      const [header] = await client.getValues(metric.name, headerRange(metric.columns.length));
      if (header?.length) assertHeader(metric, header);
      else await writeHeader(metric);
    }
    return sheetId;
  }

  return {
    async readRows(metric) {
      if (!(await loadTabs()).has(metric.name)) return [];

      const [header, ...body] = await client.getValues(metric.name, columnsRange(metric.columns.length));
      // A tab with nothing in it is fine (first write adds the header); a blank
      // header row above data is not, since appending would land below the data.
      if (header === undefined) return [];
      assertHeader(metric, header);

      // A row that is blank across every metric column (e.g. cleared by hand) carries nothing.
      return body.filter((cells) => cells.some((cell) => cell !== "")).map((cells) => decodeRow(metric, cells));
    },

    async appendRows(metric, rows) {
      if (rows.length === 0) return;
      const sheetId = await ensureTabWithHeader(metric);
      const range = columnsRange(metric.columns.length);
      await client.appendValues(metric.name, range, rows.map((row) => encodeRow(metric, row)));

      // Rows inserted by append do not inherit column formatting, so re-apply it
      // to the whole column after every write. Idempotent and one API call.
      const dateColumns = metric.columns.flatMap((c, i) => (rows.some((row) => parseSheetDate(row[c])) ? [i] : []));
      await client.formatDateTimeColumns(sheetId, dateColumns, SHEET_DATE_PATTERN);
    },
  };
}

export function encodeCell(value: CellValue): Cell {
  if (value === null) return "";
  const date = parseSheetDate(value);
  return date ? toSheetSerial(date) : value;
}

function encodeRow(metric: Metric, row: MetricRow): Cell[] {
  return metric.columns.map((column) => encodeCell(row[column] ?? null));
}

/** Formatted values are always text; an empty cell (or a trimmed trailing one) becomes null. */
function decodeRow(metric: Metric, cells: readonly string[]): MetricRow {
  return Object.fromEntries(metric.columns.map((column, i) => [column, cells[i] || null]));
}
