import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ConfigError, fromProjectRoot, loadConfig, parseConfig, parseEnv, resolveKeyFile } from "../src/config/load.js";

const valid = {
  spreadsheetId: "sheet",
  startDate: "2026-01-01",
  github: { owner: "kato-app", excludeRepos: [] },
  logging: { file: "logs/app.log" },
};

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    assert.deepEqual(parseConfig(valid), valid);
  });

  it("defaults excludeRepos to no exclusions when omitted", () => {
    const { excludeRepos: _omitted, ...github } = valid.github;
    assert.deepEqual(parseConfig({ ...valid, github }).github.excludeRepos, []);
  });

  it("rejects a blank repo name in excludeRepos with a readable message", () => {
    assert.throws(
      () => parseConfig({ ...valid, github: { ...valid.github, excludeRepos: [""] } }),
      (err: unknown) => err instanceof ConfigError && /github\.excludeRepos/.test(err.message),
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

describe("resolveKeyFile", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "health-metrics-"));

  it("returns an absolute path unchanged when the file exists", () => {
    const file = path.join(dir, "key.json");
    writeFileSync(file, "{}");
    assert.equal(resolveKeyFile({ GITHUB_TOKEN: "t", GOOGLE_SERVICE_ACCOUNT_KEY_FILE: file }), file);
  });

  it("resolves a relative path from the project root", () => {
    assert.equal(resolveKeyFile({ GITHUB_TOKEN: "t", GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "./package.json" }), fromProjectRoot("package.json"));
  });

  it("names the missing file in a ConfigError", () => {
    const file = path.join(dir, "missing.json");
    assert.throws(
      () => resolveKeyFile({ GITHUB_TOKEN: "t", GOOGLE_SERVICE_ACCOUNT_KEY_FILE: file }),
      (err: unknown) => err instanceof ConfigError && err.message.includes(file),
    );
  });
});
