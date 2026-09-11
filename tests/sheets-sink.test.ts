import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Metric } from "../src/core/metric.js";
import { SHEET_DATE_PATTERN, toSheetSerial } from "../src/core/sheet-date.js";
import { noopLogger } from "../src/logging/logger.js";
import { createSheetsSink, encodeCell } from "../src/sinks/google-sheets/sheets-sink.js";
import type { Cell, SpreadsheetClient } from "../src/sinks/google-sheets/spreadsheet-client.js";
import { fakeMetric } from "./helpers/fakes.js";

/**
 * In-memory spreadsheet. Stores cells as written and renders them the way the
 * real API does with FORMATTED_VALUE: everything becomes text, and serials in
 * a date-formatted column render with the sheet-date pattern.
 */
class InMemorySpreadsheet implements SpreadsheetClient {
  readonly tabs = new Map<string, { sheetId: number; rows: Cell[][]; dateColumns: Set<number> }>();
  readonly calls: string[] = [];
  private nextId = 100;

  constructor(existing: Record<string, Cell[][]> = {}) {
    for (const [title, rows] of Object.entries(existing)) {
      this.tabs.set(title, { sheetId: this.nextId++, rows, dateColumns: new Set() });
    }
  }

  async listTabs() {
    this.calls.push("listTabs");
    return new Map([...this.tabs].map(([title, t]) => [title, t.sheetId]));
  }

  async getValues(tab: string, range?: string) {
    this.calls.push(`getValues:${tab}:${range ?? "all"}`);
    const t = this.tabs.get(tab);
    if (!t) throw new Error(`Unable to parse range: ${tab}`);
    const rows = range === "1:1" ? t.rows.slice(0, 1) : t.rows;
    return rows.map((row, r) =>
      row.map((cell, c) => {
        if (r > 0 && t.dateColumns.has(c) && typeof cell === "number") {
          return new Date((cell - 25_569) * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
        }
        return String(cell);
      }),
    );
  }

  async appendValues(tab: string, values: readonly (readonly Cell[])[]) {
    this.calls.push(`appendValues:${tab}:${values.length}`);
    const t = this.tabs.get(tab);
    if (!t) throw new Error(`Unable to parse range: ${tab}`);
    t.rows.push(...values.map((row) => [...row]));
  }

  async addTab(title: string) {
    this.calls.push(`addTab:${title}`);
    const sheetId = this.nextId++;
    this.tabs.set(title, { sheetId, rows: [], dateColumns: new Set() });
    return sheetId;
  }

  async formatDateTimeColumns(sheetId: number, columns: readonly number[], pattern: string) {
    this.calls.push(`format:${sheetId}:${columns.join(",")}:${pattern}`);
    for (const t of this.tabs.values()) if (t.sheetId === sheetId) columns.forEach((c) => t.dateColumns.add(c));
  }
}

const metric: Metric = fakeMetric("deploys", ["published_at", "repo", "id", "name"], async () => []);
const row1 = { published_at: "2026-03-01 10:00:00", repo: "kato-app/kato", id: 100, name: "v1" };
const row2 = { published_at: "2026-03-02 10:00:00", repo: "kato-app/kato", id: 200, name: null };

describe("toSheetSerial", () => {
  it("matches Google Sheets' epoch", () => {
    assert.equal(toSheetSerial(new Date("1899-12-30T00:00:00Z")), 0);
    assert.equal(toSheetSerial(new Date("1970-01-01T00:00:00Z")), 25_569);
    assert.equal(toSheetSerial(new Date("2026-03-01T12:00:00Z")), 46_082.5);
  });
});

describe("encodeCell", () => {
  it("turns sheet dates into serials, nulls into empty strings, and leaves everything else alone", () => {
    assert.equal(encodeCell("2026-03-01 12:00:00"), 46_082.5);
    assert.equal(encodeCell(null), "");
    assert.equal(encodeCell("6.5"), "6.5");
    assert.equal(encodeCell("=HYPERLINK(\"x\")"), "=HYPERLINK(\"x\")");
    assert.equal(encodeCell(385653988), 385653988);
    assert.equal(encodeCell(true), true);
  });
});

describe("SheetsSink.readRows", () => {
  it("returns nothing for a missing or header-less tab without failing", async () => {
    const sink = createSheetsSink(new InMemorySpreadsheet({ empty: [] }), noopLogger);
    assert.deepEqual(await sink.readRows(metric), []);
    assert.deepEqual(await sink.readRows({ ...metric, name: "empty" }), []);
  });

  it("maps body rows onto the metric's columns, treating blanks and short rows as null", async () => {
    const sheet = new InMemorySpreadsheet({
      deploys: [
        ["published_at", "repo", "id", "name"],
        ["2026-03-01 10:00:00", "kato-app/kato", "100", ""],
        ["2026-03-02 10:00:00", "kato-app/kato", "200"],
      ],
    });
    const rows = await createSheetsSink(sheet, noopLogger).readRows(metric);
    assert.deepEqual(rows, [
      { published_at: "2026-03-01 10:00:00", repo: "kato-app/kato", id: "100", name: null },
      { published_at: "2026-03-02 10:00:00", repo: "kato-app/kato", id: "200", name: null },
    ]);
  });

  it("refuses a tab whose header does not match the metric", async () => {
    const sheet = new InMemorySpreadsheet({ deploys: [["published_at", "repo", "id"]] });
    await assert.rejects(createSheetsSink(sheet, noopLogger).readRows(metric), /expects \[published_at, repo, id, name\]/);
  });
});

describe("SheetsSink.appendRows", () => {
  it("creates the tab, header and date format on first write, then appends encoded rows", async () => {
    const sheet = new InMemorySpreadsheet();
    const sink = createSheetsSink(sheet, noopLogger);

    await sink.appendRows(metric, [row1, row2]);

    const tab = sheet.tabs.get("deploys");
    assert.ok(tab);
    assert.deepEqual(tab.rows[0], ["published_at", "repo", "id", "name"]);
    assert.deepEqual(tab.rows[1], [toSheetSerial(new Date("2026-03-01T10:00:00Z")), "kato-app/kato", 100, "v1"]);
    assert.deepEqual(tab.rows[2], [toSheetSerial(new Date("2026-03-02T10:00:00Z")), "kato-app/kato", 200, ""]);
    assert.ok(sheet.calls.includes(`format:${tab.sheetId}:0:${SHEET_DATE_PATTERN}`));
  });

  it("round-trips: what was appended reads back as the rows the metric wrote (ids as text)", async () => {
    const sheet = new InMemorySpreadsheet();
    const sink = createSheetsSink(sheet, noopLogger);

    await sink.appendRows(metric, [row1, row2]);
    const rows = await sink.readRows(metric);

    assert.deepEqual(rows, [
      { ...row1, id: "100" },
      { ...row2, id: "200" },
    ]);
  });

  it("writes only the header when the tab exists but is empty, and never rewrites an existing header", async () => {
    const sheet = new InMemorySpreadsheet({ deploys: [] });
    const sink = createSheetsSink(sheet, noopLogger);

    await sink.appendRows(metric, [row1]);
    await sink.appendRows(metric, [row2]);

    const tab = sheet.tabs.get("deploys");
    assert.equal(tab?.rows.length, 3);
    assert.equal(sheet.calls.filter((c) => c.startsWith("addTab")).length, 0);
    assert.equal(sheet.calls.filter((c) => c.startsWith("appendValues")).length, 3, "header + two data writes");
  });

  it("re-applies the date format after every write, since appended rows do not inherit it", async () => {
    const sheet = new InMemorySpreadsheet();
    const sink = createSheetsSink(sheet, noopLogger);

    await sink.appendRows(metric, [row1]);
    await sink.appendRows(metric, [row2]);

    const formats = sheet.calls.filter((c) => c.startsWith("format"));
    assert.equal(formats.length, 2);
    assert.ok(sheet.calls.indexOf(formats[0]!) > sheet.calls.indexOf("appendValues:deploys:1"));
  });

  it("refuses to append under a mismatched header", async () => {
    const sheet = new InMemorySpreadsheet({ deploys: [["date", "repo", "id", "name"]] });
    await assert.rejects(createSheetsSink(sheet, noopLogger).appendRows(metric, [row1]), /has columns \[date/);
    assert.equal(sheet.tabs.get("deploys")?.rows.length, 1);
  });

  it("does nothing when given no rows", async () => {
    const sheet = new InMemorySpreadsheet();
    await createSheetsSink(sheet, noopLogger).appendRows(metric, []);
    assert.deepEqual(sheet.calls, []);
  });
});
