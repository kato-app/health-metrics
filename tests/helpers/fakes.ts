import type { Config } from "../../src/config/schema.js";
import type { CollectContext, Metric, MetricRow } from "../../src/core/metric.js";
import type { MetricSink } from "../../src/core/sink.js";
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
  jira: { projects: [{ key: "GR", team: "Kato Growth" }] },
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

/** In-memory sink that records what was read and appended. */
export class InMemorySink implements MetricSink {
  readonly tabs = new Map<string, MetricRow[]>();
  readonly appendCalls: { metric: string; rows: readonly MetricRow[] }[] = [];

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
}

/** Builds a metric whose `collect` is supplied by the test. */
export function fakeMetric(
  name: string,
  columns: readonly string[],
  collect: (ctx: CollectContext) => Promise<MetricRow[]>,
): Metric {
  return { name, description: `fake ${name}`, columns, collect };
}
