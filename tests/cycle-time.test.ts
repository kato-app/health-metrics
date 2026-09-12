import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetricRow } from "../src/core/metric.js";
import type { LogContext, Logger } from "../src/logging/logger.js";
import { noopLogger } from "../src/logging/logger.js";
import { collectCycleTime, type CollectOptions } from "../src/metrics/cycle-time/collect.js";
import { cycleTime } from "../src/metrics/cycle-time/index.js";
import { COLUMNS, calendarDays, findDoneAt, findStartedAt } from "../src/metrics/cycle-time/transform.js";
import { reportUnlinkedPullRequests } from "../src/metrics/cycle-time/unlinked.js";
import type { GitHubPullRequest } from "../src/sources/github/source.js";
import {
  FakeGitHubSource,
  FakeJiraSource,
  STATUS_CATEGORIES,
  jiraIssue,
  linkedPullRequest,
  release,
  transition,
  validConfig,
} from "./helpers/fakes.js";

const kato = { owner: "kato-app", name: "kato" };
const settings = { owner: "kato-app", name: "kato-settings" };
const options: CollectOptions = {
  projects: [
    { key: "GR", team: "Kato Growth" },
    { key: "CW", team: "Kato Core" },
  ],
  repos: [kato, settings],
  startDate: "2026-01-01",
  startStatuses: ["In Progress"],
  excludedResolutions: ["Won't Do", "Duplicate", "Cannot Reproduce"],
};
const ctx = (existingRows: MetricRow[] = []) => ({ existingRows, logger: noopLogger });

const prUrl = (repo: string, n: number) => `https://github.com/kato-app/${repo}/pull/${n}`;
const note = (repo: string, n: number, title: string) => `* ${title} by @x in ${prUrl(repo, n)}`;
const pr = (repo: string, n: number, merged_at: string | null, title = `GR-1 work ${n}`): [string, GitHubPullRequest] => [
  `kato-app/${repo}#${n}`,
  { number: n, title, html_url: prUrl(repo, n), merged_at, head: { ref: `gr-1-${n}` } },
];

/** kato: v1 (2026-02-11) ships #10 and #11; v0 (2025-12-20) ships #9. kato-settings: s1 (2026-02-15) ships #5. */
function github() {
  return new FakeGitHubSource(
    {
      kato: [
        release({ id: 2, tag_name: "v1", published_at: "2026-02-11T10:00:00Z", body: [note("kato", 10, "GR-1 first"), note("kato", 11, "CW-7 thing")].join("\n") }),
        release({ id: 1, tag_name: "v0", published_at: "2025-12-20T10:00:00Z", body: note("kato", 9, "GR-9 old") }),
      ],
      "kato-settings": [release({ id: 5, tag_name: "s1", published_at: "2026-02-15T10:00:00Z", body: note("kato-settings", 5, "GR-1 second") })],
    },
    Object.fromEntries([
      pr("kato", 10, "2026-02-09T12:00:00Z"),
      pr("kato", 11, "2026-02-10T12:00:00Z", "CW-7 thing"),
      pr("kato-settings", 5, "2026-02-13T12:00:00Z"),
      pr("kato", 9, "2025-12-19T12:00:00Z"),
    ]),
  );
}

function warnRecorder(): Logger & { lines: { message: string; context?: LogContext }[] } {
  const lines: { message: string; context?: LogContext }[] = [];
  const logger: Logger = {
    ...noopLogger,
    warn: (message, context) => void lines.push(context ? { message, context } : { message }),
    child: () => logger,
  };
  return Object.assign(logger, { lines });
}

describe("transform helpers", () => {
  it("measures calendar days to two decimals, weekends included", () => {
    assert.equal(calendarDays(new Date("2026-02-06T10:00:00Z"), new Date("2026-02-09T16:00:00Z")), 3.25);
  });

  it("starts at the first configured status by name, else the first In Progress-category status, else never", () => {
    const named = jiraIssue({ key: "GR-1" });
    assert.equal(findStartedAt(named, ["in progress"], STATUS_CATEGORIES)?.toISOString(), "2026-02-03T10:00:00.000Z");

    const differentNames = jiraIssue({
      key: "GR-2",
      statusTransitions: [transition("codeReview", "2026-02-04T10:00:00Z", "sprintReady"), transition("done", "2026-02-10T16:00:00Z", "codeReview")],
    });
    assert.equal(findStartedAt(differentNames, ["In Progress"], STATUS_CATEGORIES)?.toISOString(), "2026-02-04T10:00:00.000Z");

    const neverStarted = jiraIssue({ key: "GR-3", statusTransitions: [transition("done", "2026-02-10T16:00:00Z", "toDo")] });
    assert.equal(findStartedAt(neverStarted, ["In Progress"], STATUS_CATEGORIES), null);
  });

  it("ends Jira-side at the last move into a Done-category status, falling back to the resolution date", () => {
    const reopened = jiraIssue({
      key: "GR-4",
      statusTransitions: [
        transition("inProgress", "2026-02-03T10:00:00Z"),
        transition("done", "2026-02-08T10:00:00Z", "inProgress"),
        transition("inProgress", "2026-02-09T10:00:00Z", "done"),
        transition("done", "2026-02-10T16:00:00Z", "inProgress"),
      ],
    });
    assert.equal(findDoneAt(reopened, STATUS_CATEGORIES)?.toISOString(), "2026-02-10T16:00:00.000Z");
    const noHistory = jiraIssue({ key: "GR-5", statusTransitions: [], resolvedAt: new Date("2026-02-11T00:00:00Z") });
    assert.equal(findDoneAt(noHistory, STATUS_CATEGORIES)?.toISOString(), "2026-02-11T00:00:00.000Z");
  });
});

describe("collectCycleTime", () => {
  it("emits one row per delivered issue, ending at the release of its last pull request across repos", async () => {
    const jira = new FakeJiraSource([jiraIssue({ key: "GR-1" })], { "1": [linkedPullRequest(prUrl("kato", 10)), linkedPullRequest(prUrl("kato-settings", 5))] });

    const rows = await collectCycleTime({ jira, github: github() }, options, ctx());

    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]!), [...COLUMNS]);
    assert.deepEqual(rows[0], {
      released_at: "2026-02-15 10:00:00",
      project: "GR",
      team: "Kato Growth",
      issue_key: "GR-1",
      issue_type: "Story",
      summary: "Deliver GR-1",
      created_at: "2026-02-01 09:00:00",
      started_at: "2026-02-03 10:00:00",
      done_at: "2026-02-10 16:00:00",
      last_merged_at: "2026-02-13 12:00:00",
      pr_count: 2,
      repos: "kato-app/kato, kato-app/kato-settings",
      release_tags: "kato@v1, kato-settings@s1",
      cycle_time_days: 12,
      lead_time_days: 14.04,
    });
  });

  it("applies the exclusion rules and defers issues whose work has not fully shipped", async () => {
    const issues = [
      jiraIssue({ key: "GR-101", isSubtask: true, type: "Sub-task" }),
      jiraIssue({ key: "GR-102", resolution: "Won't Do" }),
      jiraIssue({ key: "GR-103" }), // already in sheet
      jiraIssue({ key: "GR-104" }), // no pull requests at all: a spike
      jiraIssue({ key: "GR-105" }), // one merged, one still open
      jiraIssue({ key: "GR-106" }), // merged but not in any release yet
      jiraIssue({ key: "GR-107" }), // declined PR ignored, merged PR counts
      jiraIssue({ key: "GR-108" }), // PR in a repo we do not collect
      jiraIssue({ key: "GR-109" }), // released before startDate
    ];
    const jira = new FakeJiraSource(issues, {
      "103": [linkedPullRequest(prUrl("kato", 10))],
      "105": [linkedPullRequest(prUrl("kato", 10)), linkedPullRequest(prUrl("kato", 12), "OPEN")],
      "106": [linkedPullRequest(prUrl("kato", 12))],
      "107": [linkedPullRequest(prUrl("kato", 10)), linkedPullRequest(prUrl("kato", 13), "DECLINED")],
      "108": [linkedPullRequest("https://github.com/kato-app/other-repo/pull/1")],
      "109": [linkedPullRequest(prUrl("kato", 9))],
    });

    const rows = await collectCycleTime({ jira, github: github() }, options, ctx([{ issue_key: "GR-103", released_at: "2026-02-11 10:00:00" }]));

    assert.deepEqual(rows.map((r) => r.issue_key), ["GR-107"]);
    assert.equal(jira.linkedCalls.includes("103"), false, "issues already in the sheet are skipped before any lookup");
    assert.equal(jira.linkedCalls.includes("101"), false);
    assert.equal(jira.linkedCalls.includes("102"), false);
  });

  it("queries Jira from the watermark minus the grace window and never before the start date", async () => {
    const jira = new FakeJiraSource([]);

    await collectCycleTime({ jira, github: github() }, options, ctx([{ released_at: "2026-06-01 10:00:00", issue_key: "GR-1" }]));
    await collectCycleTime({ jira, github: github() }, options, ctx([{ released_at: "2026-01-20 10:00:00", issue_key: "GR-1" }]));
    await collectCycleTime({ jira, github: github() }, options, ctx());

    assert.match(jira.queries[0]!, /project in \(GR, CW\) AND statusCategory = Done AND resolved >= "2026-03-03" ORDER BY resolved ASC/);
    assert.match(jira.queries[1]!, /resolved >= "2026-01-01"/);
    assert.match(jira.queries[2]!, /resolved >= "2026-01-01"/);
  });

  it("emits a row without a start when the issue never entered a started status, and maps unknown projects to their key", async () => {
    const issue = jiraIssue({ key: "CW-7", statusTransitions: [transition("done", "2026-02-10T16:00:00Z", "toDo")] });
    const jira = new FakeJiraSource([issue], { "7": [linkedPullRequest(prUrl("kato", 11))] });

    const [row] = await collectCycleTime({ jira, github: github() }, { ...options, projects: [{ key: "CW", team: "Kato Core" }] }, ctx());

    assert.equal(row?.team, "Kato Core");
    assert.equal(row?.started_at, null);
    assert.equal(row?.cycle_time_days, null);
    assert.equal(row?.lead_time_days, 10.04);
  });

  it("orders rows by release date then issue key", async () => {
    const jira = new FakeJiraSource(
      [jiraIssue({ key: "GR-2", resolvedAt: new Date("2026-02-09T00:00:00Z") }), jiraIssue({ key: "GR-1" }), jiraIssue({ key: "CW-7" })],
      { "2": [linkedPullRequest(prUrl("kato", 10))], "1": [linkedPullRequest(prUrl("kato-settings", 5))], "7": [linkedPullRequest(prUrl("kato", 11))] },
    );

    const rows = await collectCycleTime({ jira, github: github() }, options, ctx());

    assert.deepEqual(
      rows.map((r) => [r.issue_key, r.released_at]),
      [
        ["CW-7", "2026-02-11 10:00:00"],
        ["GR-2", "2026-02-11 10:00:00"],
        ["GR-1", "2026-02-15 10:00:00"],
      ],
    );
  });
});

describe("reportUnlinkedPullRequests", () => {
  const shipped = (title: string, publishedAt: string, n = 1) => ({
    ref: { repo: kato, number: n },
    title,
    release: { repo: kato, tag: "v1", publishedAt: new Date(publishedAt) },
  });

  it("lists key-less pull requests, counts other projects, and ignores housekeeping, keyed and older releases", () => {
    const logger = warnRecorder();
    const report = reportUnlinkedPullRequests(
      [
        shipped("Hotfix for uuid migration", "2026-03-01T10:00:00Z", 1),
        shipped("Awa 10288 kf availability", "2026-03-01T10:00:00Z", 2),
        shipped("AWA-10290 amendments", "2026-03-01T10:00:00Z", 3),
        shipped("Main to Release", "2026-03-01T10:00:00Z", 4),
        shipped("GR-12 linked fine", "2026-03-01T10:00:00Z", 5),
        shipped("Old and unlinked", "2026-01-01T10:00:00Z", 6),
        shipped("Phase 2 rollout", "2026-03-01T10:00:00Z", 7),
      ],
      new Date("2026-02-01T00:00:00Z"),
      ["GR", "CW"],
      logger,
    );

    assert.deepEqual(report.unlinked.map((p) => p.ref.number), [1, 7]);
    assert.deepEqual(report.otherProjects, { AWA: 2 });
    assert.deepEqual(
      logger.lines.map((l) => l.context?.pullRequest),
      ["kato-app/kato#1", "kato-app/kato#7"],
    );
  });

  it("audits everything when there is no watermark", () => {
    const report = reportUnlinkedPullRequests([shipped("Old and unlinked", "2026-01-01T10:00:00Z")], undefined, ["GR"], noopLogger);
    assert.equal(report.unlinked.length, 1);
  });
});

describe("cycleTime factory", () => {
  it("asks the registry for repos only when collecting", async () => {
    let asked = 0;
    const repos = {
      list: async () => {
        asked += 1;
        return [kato, settings];
      },
    };
    const jira = new FakeJiraSource([jiraIssue({ key: "GR-1" })], { "1": [linkedPullRequest(prUrl("kato", 10))] });

    const metric = cycleTime({ config: validConfig, logger: noopLogger, github: github(), repos, jira });
    assert.equal(metric.name, "cycle-time");
    assert.equal(asked, 0);

    const rows = await metric.collect(ctx());
    assert.equal(asked, 1);
    assert.deepEqual(rows.map((r) => [r.issue_key, r.team]), [["GR-1", "Kato Growth"]]);
  });
});
