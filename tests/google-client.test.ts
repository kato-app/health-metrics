import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeSheetsError } from "../src/sinks/google-sheets/google-client.js";

/** Shaped like the `GaxiosError` the Sheets client throws: the API's message plus the HTTP status. */
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("describeSheetsError", () => {
  it("tells the user to share the sheet on a 403", () => {
    const error = describeSheetsError(apiError(403, "The caller does not have permission"), "abc");
    assert.match(error.message, /HTTP 403.*does not have permission.*Share the spreadsheet/);
  });

  it("points at spreadsheetId on a 404", () => {
    const error = describeSheetsError(apiError(404, "Requested entity was not found."), "abc");
    assert.match(error.message, /HTTP 404.*"abc".*config\.json/);
  });

  it("keeps the original error as the cause and copes with non-HTTP failures", () => {
    const network = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const error = describeSheetsError(network, "abc");
    assert.equal(error.message, "Google Sheets request failed: socket hang up");
    assert.equal(error.cause, network);
    assert.equal(describeSheetsError("odd", "abc").message, "Google Sheets request failed: odd");
  });
});
