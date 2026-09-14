import { sheets, type sheets_v4 } from "@googleapis/sheets";
import { GoogleAuth } from "google-auth-library";
import type { Cell, SpreadsheetClient } from "./spreadsheet-client.js";

export interface GoogleClientOptions {
  readonly spreadsheetId: string;
  /** Absolute path to the service account key JSON. */
  readonly keyFile: string;
}

/** Quotes a tab title for use in an A1 range, e.g. `'deployment-frequency'!A:H`. */
function tabRange(tab: string, range?: string): string {
  const quoted = `'${tab.replace(/'/g, "''")}'`;
  return range ? `${quoted}!${range}` : quoted;
}

/**
 * Turns a failed Sheets call into an error that says what to check. The API
 * client throws a `GaxiosError` whose message is the API's own (terse) text and
 * whose `status` is the HTTP status; the two failures a new setup hits most
 * (sheet not shared, wrong id) get a hint. The original error is kept as `cause`.
 */
export function describeSheetsError(error: unknown, spreadsheetId: string): Error {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  const reason = error instanceof Error ? error.message : String(error);
  const hints: Record<number, string> = {
    401: "The service account key was rejected; check that it is valid and not revoked",
    403: "Share the spreadsheet with the service account's email as an Editor and make sure the Google Sheets API is enabled in its project",
    404: `No spreadsheet with id "${spreadsheetId}"; check spreadsheetId in config.json`,
  };
  const hint = typeof status === "number" ? hints[status] : undefined;
  const where = typeof status === "number" ? ` (HTTP ${status})` : "";
  return new Error(`Google Sheets request failed${where}: ${reason}${hint ? `. ${hint}` : ""}`, { cause: error });
}

/** `SpreadsheetClient` backed by the Google Sheets v4 API with service account auth. */
export function createGoogleSheetsClient(options: GoogleClientOptions): SpreadsheetClient {
  const auth = new GoogleAuth({
    keyFile: options.keyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const api = sheets({ version: "v4", auth });
  const { spreadsheetId } = options;

  async function call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw describeSheetsError(error, spreadsheetId);
    }
  }

  async function batchUpdate(requests: sheets_v4.Schema$Request[]): Promise<sheets_v4.Schema$BatchUpdateSpreadsheetResponse> {
    const response = await call(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }));
    return response.data;
  }

  return {
    async listTabs() {
      const response = await call(() => api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" }));
      const tabs = new Map<string, number>();
      for (const sheet of response.data.sheets ?? []) {
        const { title, sheetId } = sheet.properties ?? {};
        if (title != null && sheetId != null) tabs.set(title, sheetId);
      }
      return tabs;
    },

    async getValues(tab, range) {
      const response = await call(() =>
        api.spreadsheets.values.get({
          spreadsheetId,
          range: tabRange(tab, range),
          valueRenderOption: "FORMATTED_VALUE",
        }),
      );
      // FORMATTED_VALUE always yields strings; the API types it loosely as any[][].
      return (response.data.values ?? []).map((row: unknown[]) => row.map(String));
    },

    async appendValues(tab, range, values) {
      // OVERWRITE fills the blank rows under the block's last data row (still
      // adding rows at the end of the sheet when needed) instead of inserting
      // new ones, so a helper column filled down beside the data is not pushed
      // out of line with the rows it refers to. The cells written are blank by
      // construction: the API finds the table within `range` and starts below it.
      await call(() =>
        api.spreadsheets.values.append({
          spreadsheetId,
          range: tabRange(tab, range),
          valueInputOption: "RAW",
          insertDataOption: "OVERWRITE",
          requestBody: { values: values.map((row) => [...row] as Cell[]) },
        }),
      );
    },

    async clearValues(tab, range) {
      await call(() => api.spreadsheets.values.clear({ spreadsheetId, range: tabRange(tab, range) }));
    },

    async addTab(title) {
      const response = await batchUpdate([{ addSheet: { properties: { title } } }]);
      const sheetId = response.replies?.[0]?.addSheet?.properties?.sheetId;
      if (sheetId == null) throw new Error(`Sheets API did not return an id for new tab "${title}"`);
      return sheetId;
    },

    async formatDateTimeColumns(sheetId, columns, pattern) {
      if (columns.length === 0) return;
      await batchUpdate(
        columns.map((column) => ({
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: column, endColumnIndex: column + 1 },
            cell: { userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern } } },
            fields: "userEnteredFormat.numberFormat",
          },
        })),
      );
    },
  };
}
