import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetricRow } from "../src/core/metric.js";
import { formatSheetDate, parseSheetDate } from "../src/core/sheet-date.js";
import { noopLogger } from "../src/logging/logger.js";
import { collectDeploymentFrequency, findWatermark } from "../src/metrics/deployment-frequency/collect.js";
import { deploymentFrequency } from "../src/metrics/deployment-frequency/index.js";
import { COLUMNS, toRow } from "../src/metrics/deployment-frequency/transform.js";
import { releaseSchema } from "../src/sources/github/source.js";
import { FakeGitHubSource, FakeJiraSource, release, validConfig } from "./helpers/fakes.js";

const kato = { owner: "kato-app", name: "kato" };
const settings = { owner: "kato-app", name: "kato-settings" };
const options = { repos: [kato, settings], startDate: "2026-01-01" };
const ctx = (existingRows: readonly MetricRow[] = []) => ({ existingRows, full: false, logger: noopLogger });

describe("sheet dates", () => {
  it("formats ISO timestamps as UTC 'YYYY-MM-DD HH:MM:SS'", () => {
    assert.equal(formatSheetDate("2026-09-09T15:49:49Z"), "2026-09-09 15:49:49");
    assert.equal(formatSheetDate("2026-09-09T16:49:49+01:00"), "2026-09-09 15:49:49");
  });

  it("round-trips through parseSheetDate and rejects other shapes", () => {
    assert.equal(parseSheetDate("2026-09-09 15:49:49")?.toISOString(), "2026-09-09T15:49:49.000Z");
    assert.equal(parseSheetDate("2026-09-09T15:49:49Z"), undefined);
    assert.equal(parseSheetDate(12345), undefined);
    assert.equal(parseSheetDate(""), undefined);
  });
});

describe("releaseSchema", () => {
  it("rejects a payload missing a field the metric depends on", () => {
    const { published_at: _dropped, ...withoutPublishedAt } = release({ id: 1 });
    assert.equal(releaseSchema.safeParse(withoutPublishedAt).success, false);
    assert.equal(releaseSchema.safeParse(release({ id: 1 })).success, true);
  });
});

describe("toRow", () => {
  it("maps a release to exactly the metric columns", () => {
    const row = toRow(kato, release({ id: 385653988, tag_name: "v77.9", name: "v77.9", published_at: "2026-09-09T15:49:49Z" }));
    assert.deepEqual(Object.keys(row), [...COLUMNS]);
    assert.deepEqual(row, {
      published_at: "2026-09-09 15:49:49",
      repo: "kato-app/kato",
      id: 385653988,
      author_login: "kato-jm",
      tag_name: "v77.9",
      name: "v77.9",
      target_commitish: "main",
      html_url: "https://github.com/kato-app/kato/releases/tag/v385653988",
    });
  });

  it("tolerates a missing author", () => {
    assert.equal(toRow(kato, release({ id: 1, author: null })).author_login, null);
  });

  it("refuses a release that has no published_at", () => {
    assert.throws(() => toRow(kato, release({ id: 7, draft: true, published_at: null })), /not been published/);
  });
});

describe("findWatermark", () => {
  it("is undefined for an empty sheet and otherwise the newest published_at", () => {
    assert.equal(findWatermark([]), undefined);
    const rows = [
      { published_at: "2026-02-01 00:00:00", id: 1 },
      { published_at: "2026-03-01 00:00:00", id: 3 },
      { published_at: "2026-02-15 00:00:00", id: 2 },
    ];
    assert.equal(findWatermark(rows)?.toISOString(), "2026-03-01T00:00:00.000Z");
  });

  it("ignores rows whose published_at is not in the sheet format", () => {
    assert.equal(findWatermark([{ published_at: "not a date", id: 1 }, { published_at: 45000, id: 2 }]), undefined);
  });
});

describe("collectDeploymentFrequency", () => {
  it("backfills from the start date on an empty sheet, oldest first, across repos", async () => {
    const github = new FakeGitHubSource({
      kato: [
        release({ id: 30, published_at: "2026-03-01T10:00:00Z" }),
        release({ id: 20, published_at: "2026-02-01T10:00:00Z" }),
        release({ id: 10, published_at: "2025-12-31T23:59:59Z" }), // before start date
        release({ id: 5, published_at: "2025-06-01T00:00:00Z" }),
      ],
      "kato-settings": [release({ id: 25, published_at: "2026-02-15T10:00:00Z" })],
    });

    const rows = await collectDeploymentFrequency(github, options, ctx());

    assert.deepEqual(
      rows.map((r) => [r.repo, r.id]),
      [
        ["kato-app/kato", 20],
        ["kato-app/kato-settings", 25],
        ["kato-app/kato", 30],
      ],
    );
    // Paging stops at the first release created before the start date; id 5 is never read.
    assert.equal(github.yielded.get("kato"), 3);
  });

  it("excludes drafts and prereleases", async () => {
    const github = new FakeGitHubSource({
      kato: [
        release({ id: 3, draft: true, published_at: null }),
        release({ id: 2, prerelease: true, published_at: "2026-03-01T10:00:00Z" }),
        release({ id: 1, published_at: "2026-02-01T10:00:00Z" }),
      ],
      "kato-settings": [],
    });

    const rows = await collectDeploymentFrequency(github, options, ctx());

    assert.deepEqual(
      rows.map((r) => r.id),
      [1],
    );
  });

  it("only returns releases not already in the sheet and stops paging past the grace window", async () => {
    // Watermark is 2026-06-01 10:00; with the 30-day grace window paging stops before 2026-05-02 10:00.
    const existing = [
      { published_at: "2026-05-05 10:00:00", id: "100" }, // Sheets hands ids back as strings
      { published_at: "2026-06-01 10:00:00", id: 200 },
    ];
    const github = new FakeGitHubSource({
      kato: [
        release({ id: 300, published_at: "2026-06-10T10:00:00Z" }), // new
        release({ id: 200, published_at: "2026-06-01T10:00:00Z" }), // already present
        // Drafted before the watermark, published after it: only the grace window catches this one.
        release({ id: 150, created_at: "2026-05-20T10:00:00Z", published_at: "2026-06-05T10:00:00Z" }),
        release({ id: 100, published_at: "2026-05-05T10:00:00Z" }), // already present, inside the window
        release({ id: 50, published_at: "2026-05-01T10:00:00Z" }), // older than the window: read, then paging stops
        release({ id: 40, published_at: "2026-03-01T10:00:00Z" }), // never read
      ],
      "kato-settings": [],
    });

    const rows = await collectDeploymentFrequency(github, options, ctx(existing));

    assert.deepEqual(
      rows.map((r) => r.id),
      [150, 300],
    );
    assert.equal(github.yielded.get("kato"), 5);
  });

  it("never pages earlier than the start date even with a wide grace window", async () => {
    const existing = [{ published_at: "2026-01-05 10:00:00", id: 2 }];
    const github = new FakeGitHubSource({
      kato: [release({ id: 2, published_at: "2026-01-05T10:00:00Z" }), release({ id: 1, published_at: "2025-12-20T10:00:00Z" })],
      "kato-settings": [],
    });

    const rows = await collectDeploymentFrequency(github, { ...options, graceDays: 365 }, ctx(existing));

    assert.deepEqual(rows, []);
    assert.equal(github.yielded.get("kato"), 2);
  });

  it("backfills from the start date when existing rows carry no readable watermark", async () => {
    const existing = [{ published_at: "garbage", id: 2 }];
    const github = new FakeGitHubSource({
      kato: [release({ id: 2, published_at: "2026-03-01T10:00:00Z" }), release({ id: 1, published_at: "2026-02-01T10:00:00Z" })],
      "kato-settings": [],
    });

    const rows = await collectDeploymentFrequency(github, options, ctx(existing));

    // Id 2 is still de-duplicated; id 1 is recovered.
    assert.deepEqual(
      rows.map((r) => r.id),
      [1],
    );
  });

  it("orders rows by published date then id when two publish in the same second", async () => {
    const github = new FakeGitHubSource({
      kato: [release({ id: 9, published_at: "2026-03-01T10:00:00Z" }), release({ id: 8, published_at: "2026-03-01T10:00:00Z" })],
      "kato-settings": [],
    });

    const rows = await collectDeploymentFrequency(github, options, ctx());

    assert.deepEqual(
      rows.map((r) => r.id),
      [8, 9],
    );
  });

  it("propagates a repository error so the whole metric run fails", async () => {
    const github = new FakeGitHubSource({ kato: [] }); // kato-settings missing => 404

    await assert.rejects(collectDeploymentFrequency(github, options, ctx()), /Not Found/);
  });
});

describe("deploymentFrequency factory", () => {
  it("asks the registry for repositories when collecting, not when constructed, so `list` stays offline", async () => {
    let asked = 0;
    const repos = {
      list: async () => {
        asked += 1;
        return [kato];
      },
    };
    const github = new FakeGitHubSource({ kato: [release({ id: 1 })], "kato-settings": [release({ id: 2 })] });

    const metric = deploymentFrequency({ config: validConfig, logger: noopLogger, github, repos, jira: new FakeJiraSource([]) });
    assert.equal(asked, 0);

    const rows = await metric.collect(ctx());
    assert.equal(asked, 1);
    assert.deepEqual(rows.map((r) => r.repo), ["kato-app/kato"], "only the registry's repos are collected");
  });
});
