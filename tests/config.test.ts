import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, parseConfig, parseEnv } from "../src/config/load.js";

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

  it("rejects a malformed start date", () => {
    assert.throws(() => parseConfig({ ...valid, startDate: "01/01/2026" }), ConfigError);
    assert.throws(() => parseConfig({ ...valid, startDate: "2026-13-45" }), ConfigError);
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
