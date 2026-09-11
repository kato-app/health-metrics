import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ConfigError, loadConfig, parseConfig, parseEnv } from "../src/config/load.js";

const valid = {
  spreadsheetId: "sheet",
  startDate: "2026-01-01",
  github: { owner: "kato-app", repos: ["kato"] },
  logging: { file: "logs/app.log" },
};

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    assert.deepEqual(parseConfig(valid), valid);
  });

  it("rejects an empty repo list with a readable message", () => {
    assert.throws(
      () => parseConfig({ ...valid, github: { ...valid.github, repos: [] } }),
      (err: unknown) => err instanceof ConfigError && /github\.repos/.test(err.message),
    );
  });

  it("rejects a malformed or impossible start date", () => {
    for (const startDate of ["01/01/2026", "2026-13-45", "2026-02-30", "2026-1-1"]) {
      assert.throws(() => parseConfig({ ...valid, startDate }), ConfigError, startDate);
    }
  });
});

describe("loadConfig", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "health-metrics-"));

  it("reports a missing file as a ConfigError", () => {
    const file = path.join(dir, "missing.json");
    assert.throws(
      () => loadConfig(file),
      (err: unknown) => err instanceof ConfigError && err.message.includes(file),
    );
  });

  it("reports malformed JSON as a ConfigError", () => {
    const file = path.join(dir, "broken.json");
    writeFileSync(file, "{ not json");
    assert.throws(() => loadConfig(file), ConfigError);
  });

  it("reads and validates a file", () => {
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(valid));
    assert.deepEqual(loadConfig(file), valid);
  });
});

describe("parseEnv", () => {
  it("names every missing variable", () => {
    assert.throws(
      () => parseEnv({}),
      (err: unknown) =>
        err instanceof ConfigError &&
        err.message.includes("GITHUB_TOKEN") &&
        err.message.includes("GOOGLE_SERVICE_ACCOUNT_KEY_FILE"),
    );
  });

  it("ignores unrelated variables", () => {
    const env = parseEnv({ GITHUB_TOKEN: "t", GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "k", PATH: "/bin" });
    assert.deepEqual(env, { GITHUB_TOKEN: "t", GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "k" });
  });
});
