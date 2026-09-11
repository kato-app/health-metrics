import type { CollectContext, Metric, MetricRow } from "../../src/core/metric.js";
import type { MetricSink } from "../../src/core/sink.js";
import type { GitHubRelease, GitHubSource, RepoRef } from "../../src/sources/github/source.js";

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

  constructor(private readonly releasesByRepo: Record<string, GitHubRelease[]>) {}

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
