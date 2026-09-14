import type { Config } from "../../src/config/schema.js";
import type { CollectContext, Metric, MetricRow } from "../../src/core/metric.js";
import type { MetricSink } from "../../src/core/sink.js";
import type { ShippedPullRequest } from "../../src/metrics/cycle-time/release-index.js";
import type { JiraIssue, JiraSource, LinkedPullRequest, StatusCategory, StatusTransition } from "../../src/sources/jira/source.js";
import {
  pullRequestKey,
  type GitHubPullRequest,
  type GitHubRelease,
  type GitHubSource,
  type PullRequestRef,
  type RepoRef,
} from "../../src/sources/github/source.js";

/** A complete, valid `config.json`; spread and override the part a test cares about. */
export const validConfig: Config = {
  spreadsheetId: "sheet",
  startDate: "2026-01-01",
  github: { owner: "kato-app", excludeRepos: [] },
  jira: {
    projects: [{ key: "GR", team: "Kato Growth" }],
    startStatuses: ["In Progress"],
    excludedResolutions: ["Won't Do", "Duplicate", "Cannot Reproduce"],
  },
  logging: { file: "logs/app.log" },
};

/** Builds a realistic published release; override whatever the test cares about. */
export function release(overrides: Partial<GitHubRelease> & { id: number }): GitHubRelease {
  const publishedAt = overrides.published_at ?? "2026-03-01T12:00:00Z";
  return {
    tag_name: `v${overrides.id}`,
    name: `v${overrides.id}`,
    target_commitish: "main",
    html_url: `https://github.com/kato-app/kato/releases/tag/v${overrides.id}`,
    draft: false,
    prerelease: false,
    // Default: commit 10 seconds before publish, as with a release cut straight after a merge.
    created_at: publishedAt ? new Date(new Date(publishedAt).getTime() - 10_000).toISOString() : "2026-03-01T11:59:50Z",
    published_at: publishedAt,
    author: { login: "kato-jm" },
    ...overrides,
  };
}

/**
 * In-memory GitHub. Releases are yielded in the order given (tests supply
 * newest-created first, as the real API does) and `yielded` records how many
 * were consumed so tests can prove paging stopped early.
 */
export class FakeGitHubSource implements GitHubSource {
  readonly yielded = new Map<string, number>();
  discoveryCalls = 0;

  constructor(
    private readonly releasesByRepo: Record<string, GitHubRelease[]>,
    /** Keyed by `owner/name#number`, as `pullRequestKey` produces. */
    private readonly pullRequests: Record<string, GitHubPullRequest> = {},
  ) {}

  async getPullRequest(ref: PullRequestRef): Promise<GitHubPullRequest> {
    const pr = this.pullRequests[pullRequestKey(ref)];
    if (!pr) throw new Error(`Not Found: ${pullRequestKey(ref)}`);
    return pr;
  }

  /** Every configured repo with at least one release, mirroring the GraphQL discovery. */
  async listReposWithReleases(_org: string): Promise<string[]> {
    this.discoveryCalls += 1;
    return Object.entries(this.releasesByRepo)
      .filter(([, releases]) => releases.length > 0)
      .map(([name]) => name);
  }

  async *listReleases(repo: RepoRef): AsyncIterable<GitHubRelease> {
    const releases = this.releasesByRepo[repo.name];
    if (!releases) throw new Error(`Not Found: ${repo.owner}/${repo.name}`);
    for (const r of releases) {
      this.yielded.set(repo.name, (this.yielded.get(repo.name) ?? 0) + 1);
      yield r;
    }
  }
}

/** A pull request from kato-app/kato as the release index lists it, shipped in release `v1`. */
export function shippedPullRequest(title: string, number: number, publishedAt = "2026-03-01T10:00:00Z", author = "kato-jm"): ShippedPullRequest {
  const repo = { owner: "kato-app", name: "kato" };
  return { ref: { repo, number }, title, author, release: { repo, tag: "v1", publishedAt: new Date(publishedAt) } };
}

/** In-memory sink that records every append and replace. */
export class InMemorySink implements MetricSink {
  readonly tabs = new Map<string, MetricRow[]>();
  readonly appendCalls: { metric: string; rows: readonly MetricRow[] }[] = [];
  readonly replaceCalls: { metric: string; rows: readonly MetricRow[] }[] = [];

  seed(metricName: string, rows: MetricRow[]): void {
    this.tabs.set(metricName, [...rows]);
  }

  async readRows(metric: Metric): Promise<MetricRow[]> {
    return [...(this.tabs.get(metric.name) ?? [])];
  }

  async appendRows(metric: Metric, rows: readonly MetricRow[]): Promise<void> {
    this.appendCalls.push({ metric: metric.name, rows });
    this.tabs.set(metric.name, [...(this.tabs.get(metric.name) ?? []), ...rows]);
  }

  async replaceRows(metric: Metric, rows: readonly MetricRow[]): Promise<void> {
    this.replaceCalls.push({ metric: metric.name, rows });
    this.tabs.set(metric.name, [...rows]);
  }
}

/** Builds a metric whose `collect` is supplied by the test. */
export function fakeMetric(
  name: string,
  columns: readonly string[],
  collect: (ctx: CollectContext) => Promise<MetricRow[]>,
): Metric {
  return { name, description: `fake ${name}`, columns, collect };
}

/** Status ids and categories used by the Jira fakes, mirroring a typical Jira Cloud workflow. */
export const STATUS = {
  toDo: { id: "1", name: "To Do", category: "new" },
  sprintReady: { id: "2", name: "Sprint Ready", category: "new" },
  inProgress: { id: "3", name: "In Progress", category: "indeterminate" },
  codeReview: { id: "4", name: "Code Review", category: "indeterminate" },
  readyForTesting: { id: "5", name: "Ready for Testing", category: "indeterminate" },
  done: { id: "6", name: "Done", category: "done" },
} as const;

type StatusName = keyof typeof STATUS;

export const STATUS_CATEGORIES: ReadonlyMap<string, StatusCategory> = new Map(
  Object.values(STATUS).map((s) => [s.id, s.category]),
);

/** A status transition into `to` at `at`, from the previous status if given. */
export function transition(to: StatusName, at: string, from?: StatusName): StatusTransition {
  return {
    at: new Date(at),
    fromStatusId: from ? STATUS[from].id : null,
    fromStatus: from ? STATUS[from].name : null,
    toStatusId: STATUS[to].id,
    toStatus: STATUS[to].name,
  };
}

/** Builds a resolved Jira story; override whatever the test cares about. */
export function jiraIssue(overrides: Partial<JiraIssue> & { key: string }): JiraIssue {
  return {
    id: overrides.key.replace(/\D/g, "") || "1",
    projectKey: overrides.key.split("-")[0]!,
    type: "Story",
    isSubtask: false,
    summary: `Deliver ${overrides.key}`,
    status: "Done",
    statusCategory: "done",
    resolution: "Done",
    createdAt: new Date("2026-02-01T09:00:00Z"),
    resolvedAt: new Date("2026-02-10T16:00:00Z"),
    statusTransitions: [
      transition("sprintReady", "2026-02-02T09:00:00Z", "toDo"),
      transition("inProgress", "2026-02-03T10:00:00Z", "sprintReady"),
      transition("done", "2026-02-10T16:00:00Z", "inProgress"),
    ],
    ...overrides,
  };
}

/** A pull request as Jira's development panel reports it. */
export function linkedPullRequest(url: string, status = "MERGED", sourceBranch: string | null = null): LinkedPullRequest {
  return { url, title: null, status, sourceBranch, lastUpdate: new Date("2026-02-09T12:00:00Z") };
}

/**
 * In-memory Jira. `searchIssues` only records the JQL, so tests can assert on
 * the query, and yields every issue oldest resolved first.
 */
export class FakeJiraSource implements JiraSource {
  readonly queries: string[] = [];
  readonly linkedCalls: string[] = [];

  constructor(
    private readonly issues: readonly JiraIssue[],
    private readonly linked: Record<string, LinkedPullRequest[]> = {},
    private readonly categories: ReadonlyMap<string, StatusCategory | string> = STATUS_CATEGORIES,
    /** What `searchIssueKeys` answers, whatever the JQL: the keys of issues with no development information. */
    private readonly issueKeysWithoutLinks: readonly string[] = [],
  ) {}

  async *searchIssues(jql: string): AsyncIterable<JiraIssue> {
    this.queries.push(jql);
    yield* [...this.issues].sort((a, b) => (a.resolvedAt?.getTime() ?? 0) - (b.resolvedAt?.getTime() ?? 0));
  }

  async *searchIssueKeys(jql: string): AsyncIterable<string> {
    this.queries.push(jql);
    yield* this.issueKeysWithoutLinks;
  }

  async listStatusCategories() {
    return this.categories;
  }

  async listLinkedPullRequests(issueId: string): Promise<LinkedPullRequest[]> {
    this.linkedCalls.push(issueId);
    return this.linked[issueId] ?? [];
  }
}
