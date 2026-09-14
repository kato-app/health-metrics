import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noopLogger } from "../src/logging/logger.js";
import { UNLINKED_REASONS, classifyUnlinked } from "../src/metrics/unlinked-prs/classify.js";
import { COLUMNS, collectUnlinkedPullRequests } from "../src/metrics/unlinked-prs/collect.js";
import { unlinkedPrs } from "../src/metrics/unlinked-prs/index.js";
import { FakeGitHubSource, FakeJiraSource, release, validConfig } from "./helpers/fakes.js";

const kato = { owner: "kato-app", name: "kato" };
const settings = { owner: "kato-app", name: "kato-settings" };
const PROJECTS = ["GR", "CW"];

const shipped = (title: string, n: number, publishedAt = "2026-03-01T10:00:00Z", author = "kato-jm") => ({
  ref: { repo: kato, number: n },
  title,
  author,
  release: { repo: kato, tag: "v1", publishedAt: new Date(publishedAt) },
});

describe("classifyUnlinked", () => {
  it("reports key-less, foreign-project and never-linked pull requests, and ignores housekeeping and linked ones", () => {
    const result = classifyUnlinked(
      [
        shipped("Hotfix for uuid migration", 1),
        shipped("Awa 10288 kf availability", 2),
        shipped("Fix AWA-10290 amendments", 3),
        shipped("Main to Release", 4),
        shipped("GR-12 linked fine", 5),
        shipped("GR-103 never linked in Jira", 6),
        shipped("GR-103 and CW-1 half linked", 7),
        shipped("Upgrade to Node 22", 8),
      ],
      PROJECTS,
      new Set(["GR-103"]),
    );

    assert.deepEqual(
      result.map((u) => [u.pullRequest.ref.number, u.reason, u.issueKeys]),
      [
        [1, UNLINKED_REASONS.noKey, []],
        [2, UNLINKED_REASONS.unknownProject, ["AWA-10288"]],
        [3, UNLINKED_REASONS.unknownProject, ["AWA-10290"]],
        [6, UNLINKED_REASONS.notLinkedInJira, ["GR-103"]],
        [8, UNLINKED_REASONS.noKey, []],
      ],
    );
  });
});

describe("collectUnlinkedPullRequests", () => {
  const note = (repo: string, n: number, title: string, by = "kato-jm") => `* ${title} by @${by} in https://github.com/kato-app/${repo}/pull/${n}`;
  const github = () =>
    new FakeGitHubSource({
      kato: [
        release({ id: 2, tag_name: "v2", published_at: "2026-03-01T10:00:00Z", body: [note("kato", 20, "Hotfix for uuid migration", "sam"), note("kato", 21, "GR-103 never linked")].join("\n") }),
        release({ id: 1, tag_name: "v1", published_at: "2026-02-01T10:00:00Z", body: [note("kato", 10, "GR-1 fine"), note("kato", 11, "Awa 10288 legacy", "alex"), note("kato", 12, "v1")].join("\n") }),
        release({ id: 0, tag_name: "v0", published_at: "2025-12-01T10:00:00Z", body: note("kato", 5, "Ancient unlinked") }),
      ],
      "kato-settings": [release({ id: 7, tag_name: "s7", published_at: "2026-02-15T10:00:00Z", body: note("kato-settings", 3, "Tidy config", "jo") })],
    });
  const options = { projects: validConfig.jira.projects.concat({ key: "CW", team: "Kato Core" }), repos: [kato, settings], startDate: "2026-01-01" };
  const ctx = { existingRows: [], full: false, logger: noopLogger };

  it("produces one row per unlinked pull request since startDate, oldest release first, with author and reason", async () => {
    const jira = new FakeJiraSource([], {}, undefined, ["GR-103"]);

    const rows = await collectUnlinkedPullRequests({ jira, github: github() }, options, ctx);

    assert.deepEqual(Object.keys(rows[0]!), [...COLUMNS]);
    assert.deepEqual(
      rows.map((r) => [r.released_at, r.repo, r.pr_number, r.author, r.reason, r.issue_keys]),
      [
        ["2026-02-01 10:00:00", "kato-app/kato", 11, "alex", UNLINKED_REASONS.unknownProject, "AWA-10288"],
        ["2026-02-15 10:00:00", "kato-app/kato-settings", 3, "jo", UNLINKED_REASONS.noKey, ""],
        ["2026-03-01 10:00:00", "kato-app/kato", 20, "sam", UNLINKED_REASONS.noKey, ""],
        ["2026-03-01 10:00:00", "kato-app/kato", 21, "kato-jm", UNLINKED_REASONS.notLinkedInJira, "GR-103"],
      ],
    );
    assert.equal(rows[0]?.url, "https://github.com/kato-app/kato/pull/11");
    assert.equal(rows[0]?.release_tag, "v1");
  });

  it("asks Jira for issues in the configured projects with no linked pull requests since startDate", async () => {
    const jira = new FakeJiraSource([]);

    await collectUnlinkedPullRequests({ jira, github: github() }, options, ctx);

    assert.deepEqual(jira.queries, [`project in (GR, CW) AND development[pullrequests].all = 0 AND updated >= "2026-01-01"`]);
  });

  it("returns no rows when everything is linked, so the tab empties", async () => {
    const jira = new FakeJiraSource([]);
    const clean = new FakeGitHubSource({ kato: [release({ id: 1, published_at: "2026-02-01T10:00:00Z", body: note("kato", 10, "GR-1 fine") })] });

    assert.deepEqual(await collectUnlinkedPullRequests({ jira, github: clean }, { ...options, repos: [kato] }, ctx), []);
  });
});

describe("unlinkedPrs factory", () => {
  it("is a snapshot metric that asks the registry for repos only when collecting", async () => {
    let asked = 0;
    const repos = {
      list: async () => {
        asked += 1;
        return [kato];
      },
    };
    const metric = unlinkedPrs({ config: validConfig, logger: noopLogger, github: new FakeGitHubSource({ kato: [] }), repos, jira: new FakeJiraSource([]) });

    assert.equal(metric.name, "unlinked-prs");
    assert.equal(metric.mode, "snapshot");
    assert.equal(asked, 0);
    assert.deepEqual(await metric.collect({ existingRows: [], full: false, logger: noopLogger }), []);
    assert.equal(asked, 1);
  });
});
