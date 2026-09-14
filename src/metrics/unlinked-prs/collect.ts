import type { JiraProject } from "../../config/schema.js";
import { compareRows, type CollectContext, type MetricRow } from "../../core/metric.js";
import { formatSheetDate, startOfUtcDay } from "../../core/sheet-date.js";
import { repoFullName, type GitHubSource, type RepoRef } from "../../sources/github/source.js";
import type { JiraSource } from "../../sources/jira/source.js";
import { buildReleaseIndex } from "../cycle-time/release-index.js";
import { classifyUnlinked, type UnlinkedPullRequest } from "./classify.js";

export const COLUMNS = ["released_at", "repo", "pr_number", "author", "title", "reason", "issue_keys", "release_tag", "url"] as const;

export interface UnlinkedPrsSources {
  readonly jira: JiraSource;
  readonly github: GitHubSource;
}

export interface CollectOptions {
  readonly projects: readonly JiraProject[];
  readonly repos: readonly RepoRef[];
  /** `YYYY-MM-DD`; pull requests shipped before this UTC day are ignored. */
  readonly startDate: string;
}

function toRow({ pullRequest, reason, issueKeys }: UnlinkedPullRequest): MetricRow {
  const { ref, release } = pullRequest;
  return {
    released_at: formatSheetDate(release.publishedAt),
    repo: repoFullName(ref.repo),
    pr_number: ref.number,
    author: pullRequest.author,
    title: pullRequest.title,
    reason,
    issue_keys: issueKeys.join(", "),
    release_tag: release.tag,
    url: `https://github.com/${ref.repo.owner}/${ref.repo.name}/pull/${ref.number}`,
  };
}

/**
 * The complete, current list of shipped pull requests that cycle time cannot
 * attribute to a configured Jira issue. A snapshot: every run re-audits every
 * release since `startDate`, so fixing a title (or linking the issue) removes
 * the row on the next run. `--full` changes nothing here.
 */
export async function collectUnlinkedPullRequests(sources: UnlinkedPrsSources, options: CollectOptions, context: CollectContext): Promise<MetricRow[]> {
  const { logger } = context;
  const projectKeys = options.projects.map((p) => p.key);
  const startDate = startOfUtcDay(options.startDate);

  // Jira's development[] JQL fields are backed by the same integration data as
  // the issue's Development panel, so one search finds every issue in scope
  // that has no pull request linked at all.
  const jql = `project in (${projectKeys.join(", ")}) AND development[pullrequests].all = 0 AND updated >= "${options.startDate}"`;
  const [index, keysWithoutLinks] = await Promise.all([
    buildReleaseIndex(sources.github, options.repos, startDate, logger),
    Array.fromAsync(sources.jira.searchIssueKeys(jql)),
  ]);
  const issuesWithoutLinks = new Set(keysWithoutLinks);

  const unlinked = classifyUnlinked(index.shipped, projectKeys, issuesWithoutLinks);
  const byReason: Record<string, number> = {};
  for (const { reason } of unlinked) byReason[reason] = (byReason[reason] ?? 0) + 1;
  logger.info("Audited shipped pull requests", {
    shipped: index.shipped.length,
    issuesWithoutLinks: issuesWithoutLinks.size,
    unlinked: unlinked.length,
    byReason,
  });

  return unlinked.map(toRow).sort(compareRows("released_at", "repo", "pr_number"));
}
