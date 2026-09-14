/** A value the Sheets API accepts in a cell when writing with the RAW input option. */
export type Cell = string | number | boolean;

/**
 * The handful of spreadsheet operations the sink needs, kept separate from the
 * Google API client so the sink's mapping logic can be tested in memory.
 */
export interface SpreadsheetClient {
  /** Tab title to sheet id for every tab in the spreadsheet. */
  listTabs(): Promise<Map<string, number>>;
  /**
   * Cell values as the user sees them (formatted text), row-major, restricted
   * to `range` (A1 notation within the tab, e.g. `A:H`; the whole tab if
   * omitted). Trailing empty cells and rows are trimmed.
   */
  getValues(tab: string, range?: string): Promise<string[][]>;
  /**
   * Appends rows below the last row that has data within `range`, starting at
   * the range's first column. Data outside the range (a user's helper columns)
   * does not affect where the rows land and is not moved: rows are written into
   * the blank cells below the block, growing the sheet only when it runs out.
   */
  appendValues(tab: string, range: string, values: readonly (readonly Cell[])[]): Promise<void>;
  /** Blanks every cell in `range` (A1 notation within the tab), leaving formatting in place. */
  clearValues(tab: string, range: string): Promise<void>;
  /** Creates an empty tab and returns its sheet id. */
  addTab(title: string): Promise<number>;
  /** Applies a date-time number format to whole columns (zero-based indexes), skipping the header row. */
  formatDateTimeColumns(sheetId: number, columns: readonly number[], pattern: string): Promise<void>;
}
