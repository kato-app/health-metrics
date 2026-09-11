import type { CellValue, Metric, MetricRow } from "../../core/metric.js";
import { SHEET_DATE_PATTERN, parseSheetDate, toSheetSerial } from "../../core/sheet-date.js";
import type { MetricSink } from "../../core/sink.js";
import type { Logger } from "../../logging/logger.js";
import type { Cell, SpreadsheetClient } from "./spreadsheet-client.js";

/**
 * Stores each metric in a tab named after it, with the metric's columns as the
 * header row.
 *
 * Encoding: rows are written RAW so Sheets never reinterprets text as a number,
 * date or formula. Cells in sheet-date format are the exception: they become
 * native date-time serials, and their columns are given a matching number
 * format after every write, so they read back as the same text.
 */
export function createSheetsSink(client: SpreadsheetClient, logger: Logger): MetricSink {
  const log = logger.child({ sink: "google-sheets" });

  function assertHeader(metric: Metric, header: readonly string[]): void {
    const expected = metric.columns;
    const matches = header.length === expected.length && expected.every((c, i) => header[i] === c);
    if (!matches) {
      throw new Error(
        `Tab "${metric.name}" has columns [${header.join(", ")}] but the metric expects [${expected.join(", ")}]`,
      );
    }
  }

  /** Returns the tab's sheet id, creating the tab and its header row if needed. */
  async function ensureTabWithHeader(metric: Metric): Promise<number> {
    const tabs = await client.listTabs();
    let sheetId = tabs.get(metric.name);
    if (sheetId === undefined) {
      sheetId = await client.addTab(metric.name);
      log.info("Created tab", { tab: metric.name });
    }

    const [header] = await client.getValues(metric.name, "1:1");
    if (header && header.length > 0) {
      assertHeader(metric, header);
    } else {
      await client.appendValues(metric.name, [[...metric.columns]]);
      log.info("Wrote header", { tab: metric.name });
    }
    return sheetId;
  }

  return {
    async readRows(metric) {
      const tabs = await client.listTabs();
      if (!tabs.has(metric.name)) return [];

      const [header, ...body] = await client.getValues(metric.name);
      if (!header || header.length === 0) return [];
      assertHeader(metric, header);

      return body.map((cells) => decodeRow(metric, cells));
    },

    async appendRows(metric, rows) {
      const [first] = rows;
      if (!first) return;
      const sheetId = await ensureTabWithHeader(metric);
      await client.appendValues(metric.name, rows.map((row) => encodeRow(metric, row)));

      // Rows inserted by append do not inherit column formatting, so re-apply it
      // to the whole column after every write. Idempotent and one API call.
      const dateColumns = metric.columns.flatMap((c, i) => (parseSheetDate(first[c]) ? [i] : []));
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
  return Object.fromEntries(metric.columns.map((column, i) => [column, cells[i] === undefined || cells[i] === "" ? null : cells[i]]));
}
