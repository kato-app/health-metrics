import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ConfigError, fromProjectRoot, loadConfig, parseConfig, parseEnv, resolveKeyFile } from "../src/config/load.js";
import { validConfig as valid } from "./helpers/fakes.js";

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    assert.deepEqual(parseConfig(valid), valid);
  });

  it("defaults excludeRepos to no exclusions when omitted", () => {
    const { excludeRepos: _omitted, ...github } = valid.github;
    assert.deepEqual(parseConfig({ ...valid, github }).github.excludeRepos, []);
  });

  it("fills in the change-failure section and its fields when omitted", () => {
    const { changeFailure: _omitted, ...withoutSection } = valid;
    assert.deepEqual(parseConfig(withoutSection).changeFailure, { settlingDays: 14, keylessAttributionDays: 3, regressionLabel: "regression" });
    assert.equal(parseConfig({ ...valid, changeFailure: { settlingDays: 7 } }).changeFailure.keylessAttributionDays, 3, "a partial section keeps the other defaults");
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

  const complete = {
    GITHUB_TOKEN: "t",
    GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "k",
    ATLASSIAN_BASE_URL: "https://example.atlassian.net",
    ATLASSIAN_EMAIL: "me@example.com",
    ATLASSIAN_TOKEN: "j",
  };

  it("ignores unrelated variables", () => {
    assert.deepEqual(parseEnv({ ...complete, PATH: "/bin" }), complete);
  });

  it("rejects a malformed or non-https Jira site URL and a malformed email", () => {
    for (const ATLASSIAN_BASE_URL of ["example.atlassian.net", "http://example.atlassian.net"]) {
      assert.throws(() => parseEnv({ ...complete, ATLASSIAN_BASE_URL }), ConfigError, ATLASSIAN_BASE_URL);
    }
    assert.throws(() => parseEnv({ ...complete, ATLASSIAN_EMAIL: "not-an-email" }), ConfigError);
  });
});

describe("resolveKeyFile", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "health-metrics-"));

  it("returns an absolute path unchanged when the file exists", () => {
    const file = path.join(dir, "key.json");
    writeFileSync(file, "{}");
    assert.equal(resolveKeyFile({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: file }), file);
  });

  it("resolves a relative path from the project root", () => {
    assert.equal(resolveKeyFile({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: "./package.json" }), fromProjectRoot("package.json"));
  });

  it("names the missing file in a ConfigError", () => {
    const file = path.join(dir, "missing.json");
    assert.throws(
      () => resolveKeyFile({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: file }),
      (err: unknown) => err instanceof ConfigError && err.message.includes(file),
    );
  });
});
