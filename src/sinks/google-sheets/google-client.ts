import { sheets, type sheets_v4 } from "@googleapis/sheets";
import { GoogleAuth } from "google-auth-library";
import type { Cell, SpreadsheetClient } from "./spreadsheet-client.js";

export interface GoogleClientOptions {
  readonly spreadsheetId: string;
  /** Absolute path to the service account key JSON. */
  readonly keyFile: string;
}

/** Quotes a tab title for use in an A1 range, e.g. `'deployment-frequency'!1:1`. */
function tabRange(tab: string, range?: string): string {
  const quoted = `'${tab.replace(/'/g, "''")}'`;
  return range ? `${quoted}!${range}` : quoted;
}

/** `SpreadsheetClient` backed by the Google Sheets v4 API with service account auth. */
export function createGoogleSheetsClient(options: GoogleClientOptions): SpreadsheetClient {
  const auth = new GoogleAuth({
    keyFile: options.keyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const api = sheets({ version: "v4", auth });
  const { spreadsheetId } = options;

  async function batchUpdate(requests: sheets_v4.Schema$Request[]): Promise<sheets_v4.Schema$BatchUpdateSpreadsheetResponse> {
    const response = await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    return response.data;
  }

  return {
    async listTabs() {
      const response = await api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" });
      const tabs = new Map<string, number>();
      for (const sheet of response.data.sheets ?? []) {
        const { title, sheetId } = sheet.properties ?? {};
        if (title != null && sheetId != null) tabs.set(title, sheetId);
      }
      return tabs;
    },

    async getValues(tab, range) {
      const response = await api.spreadsheets.values.get({
        spreadsheetId,
        range: tabRange(tab, range),
        valueRenderOption: "FORMATTED_VALUE",
      });
      // FORMATTED_VALUE always yields strings; the API types it loosely as any[][].
      return (response.data.values ?? []).map((row: unknown[]) => row.map(String));
    },

    async appendValues(tab, values) {
      await api.spreadsheets.values.append({
        spreadsheetId,
        range: tabRange(tab),
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: values.map((row) => [...row] as Cell[]) },
      });
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
