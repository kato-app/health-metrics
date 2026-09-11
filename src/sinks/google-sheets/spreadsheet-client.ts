/** A value the Sheets API accepts in a cell when writing with the RAW input option. */
export type Cell = string | number | boolean;

/**
 * The handful of spreadsheet operations the sink needs, kept separate from the
 * Google API client so the sink's mapping logic can be tested in memory.
 */
export interface SpreadsheetClient {
  /** Tab title to sheet id for every tab in the spreadsheet. */
  listTabs(): Promise<Map<string, number>>;
  /** Cell values as the user sees them (formatted text), row-major, trailing empties trimmed. */
  getValues(tab: string, range?: string): Promise<string[][]>;
  /** Appends rows after the last row that has data. */
  appendValues(tab: string, values: readonly (readonly Cell[])[]): Promise<void>;
  /** Creates an empty tab and returns its sheet id. */
  addTab(title: string): Promise<number>;
  /** Applies a date-time number format to whole columns (zero-based indexes), skipping the header row. */
  formatDateTimeColumns(sheetId: number, columns: readonly number[], pattern: string): Promise<void>;
}
