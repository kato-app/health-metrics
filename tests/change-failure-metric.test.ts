import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetricRow } from "../src/core/metric.js";
import { noopLogger } from "../src/logging/logger.js";
import { COLUMNS, collectChangeFailure, type CollectOptions } from "../src/metrics/change-failure/collect.js";
import { changeFailure, unclaimedHotfixes } from "../src/metrics/change-failure/index.js";
import { COLUMNS as UNCLAIMED_COLUMNS, collectUnclaimedHotfixes } from "../src/metrics/change-failure/unclaimed.js";
import { changeFailureScenario, validConfig } from "./helpers/fakes.js";

const kato = { owner: "kato-app", name: "kato" };
const settings = { owner: "kato-app", name: "kato-settings" };

/** See `changeFailureScenario` for the timeline; on Apr 1 everything but v75.0 has settled. */
const options: CollectOptions = {
  projects: [{ key: "GR", team: "Kato Growth" }, { key: "CW", team: "Kato Core" }],
  repos: [kato, settings],
  startDate: "2026-01-01",
  settlingDays: 14,
  keylessAttributionDays: 3,
  regressionLabel: "regression",
  now: new Date("2026-04-01T00:00:00Z"),
};
const ctx = (existingRows: readonly MetricRow[] = [], full = false) => ({ existingRows, full, logger: noopLogger });

describe("collectChangeFailure", () => {
  it("writes one row per settled release with a column per signal, oldest first", async () => {
    const rows = await collectChangeFailure(changeFailureScenario(), options, ctx());

    assert.deepEqual(Object.keys(rows[0]!), [...COLUMNS]);
    assert.deepEqual(
      rows.map((r) => [r.tag, r.failed, r.hotfix, r.revert, r.patch_tag, r.jira_regression, r.remediated_by, r.days_to_remediation]),
      [
        ["v70.0", true, 'kato-app/kato#711 "GR-9: Hotfix null pointer"', null, null, null, "v71.0.1", 11],
        ["s1", false, null, null, null, null, null, null],
        ["v71.0", true, null, null, "v71.0.1", "GR-210", "v71.0.1, v72.0", 0.96],
        ["v71.0.1", false, null, null, null, null, null, null],
        ["s2", false, null, null, null, null, null, null],
        ["v72.0", true, 'kato-app/kato#730 "Hotfix broken login"', null, null, null, "v73.0", 1],
        ["v73.0", false, null, null, null, null, null, null],
        ["v74.0", false, null, null, null, null, null, null],
      ],
      "v75.0 is inside the 14-day settling window and not yet judged",
    );
    assert.equal(rows.find((r) => r.tag === "v71.0")?.first_remediation_at, "2026-02-11 09:00:00", "the regression bug was raised before the patch shipped");
  });

  it("skips releases already in the sheet and only revisits the grace window unless --full", async () => {
    const existing = [
      { released_at: "2026-02-01 10:00:00", repo: "kato-app/kato", tag: "v70.0" },
      { released_at: "2026-03-02 10:00:00", repo: "kato-app/kato", tag: "v73.0" },
    ];

    const incremental = await collectChangeFailure(changeFailureScenario(), { ...options, graceDays: 5 }, ctx(existing));
    assert.deepEqual(incremental.map((r) => r.tag), ["v72.0", "v74.0"], "within 5 days of the watermark, minus what is already there");

    const full = await collectChangeFailure(changeFailureScenario(), { ...options, graceDays: 5 }, ctx(existing, true));
    assert.deepEqual(full.map((r) => r.tag), ["s1", "v71.0", "v71.0.1", "s2", "v72.0", "v74.0"]);
  });

  it("judges nothing when every release is still settling", async () => {
    const rows = await collectChangeFailure(changeFailureScenario(), { ...options, now: new Date("2026-02-10T00:00:00Z") }, ctx());
    assert.deepEqual(rows, []);
  });
});

describe("collectUnclaimedHotfixes", () => {
  it("lists every remediation that could not be attributed, with author and reason", async () => {
    const rows = await collectUnclaimedHotfixes(changeFailureScenario(), options, ctx());

    assert.deepEqual(Object.keys(rows[0]!), [...UNCLAIMED_COLUMNS]);
    assert.deepEqual(
      rows.map((r) => [r.released_at, r.repo, r.tag, r.signal, r.author]),
      [
        ["2026-02-20 10:00:00", "kato-app/kato-settings", "s2", "hotfix", "jo"],
        ["2026-03-12 10:00:00", "kato-app/kato", "v74.0", "revert", "kato-jm"],
      ],
    );
    assert.match(String(rows[0]?.reason), /no known issue key, and the previous release s1 is 15.0 days older/);
  });
});

describe("factories", () => {
  it("build both metrics from config and ask the registry for repos only when collecting", async () => {
    let asked = 0;
    const repos = {
      list: async () => {
        asked += 1;
        return [kato, settings];
      },
    };
    const deps = { config: validConfig, logger: noopLogger, ...changeFailureScenario(), repos };

    const failure = changeFailure(deps);
    const unclaimed = unclaimedHotfixes(deps);
    assert.equal(failure.name, "change-failure");
    assert.equal(failure.mode, undefined, "append metric");
    assert.equal(unclaimed.name, "unclaimed-hotfixes");
    assert.equal(unclaimed.mode, "snapshot");
    assert.equal(asked, 0);

    const rows = await unclaimed.collect(ctx());
    assert.equal(asked, 1);
    assert.equal(rows.length, 2);
  });
});
